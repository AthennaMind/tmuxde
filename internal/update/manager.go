package update

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// Manager owns one explicit batch. It never schedules release discovery.
type Manager struct {
	mu      sync.Mutex
	dir     string
	source  releaseSource
	targets func() []Target
	state   Status
	cancel  context.CancelFunc
	closed  bool
	done    chan struct{}
}

type releaseSource interface {
	Check(context.Context) (*Snapshot, error)
	Download(context.Context, Release, Component, string) (Package, error)
}

func NewManager(dir string, targets func() []Target) (*Manager, error) {
	m := &Manager{
		dir:     filepath.Join(dir, "updates"),
		source:  NewSource(),
		targets: targets,
	}
	if err := read(filepath.Join(m.dir, "state.json"), &m.state); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return m, nil
}

func (m *Manager) persist() error {
	return save(filepath.Join(m.dir, "state.json"), m.state)
}

func (m *Manager) Check(ctx context.Context) error {
	m.mu.Lock()
	busy := m.state.Job != nil && m.state.Job.Active
	m.mu.Unlock()
	if busy {
		return errors.New("wait for current update to finish")
	}
	snapshot, err := m.source.Check(ctx)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state.Snapshot = snapshot
	return m.persist()
}

func cloneStatus(state Status) Status {
	state.Components = slices.Clone(state.Components)
	if state.Snapshot != nil {
		snapshot := *state.Snapshot
		snapshot.Release.Assets = slices.Clone(snapshot.Release.Assets)
		state.Snapshot = &snapshot
	}
	if state.Job != nil {
		job := *state.Job
		job.Items = slices.Clone(job.Items)
		state.Job = &job
	}
	return state
}

func activePhase(phase string) bool {
	switch phase {
	case "starting", "installing", "restarting", "rolling-back", "awaiting-reconnect":
		return true
	default:
		return false
	}
}

// Status reads inventory and journals only. It cannot start a download or install.
func (m *Manager) Status(ctx context.Context) Status {
	targets := m.targets()
	m.mu.Lock()
	defer m.mu.Unlock()
	state := cloneStatus(m.state)
	state.Components = []Component{}
	for _, target := range targets {
		info := target.Info(ctx)
		if state.Snapshot != nil {
			info = state.Snapshot.Release.offered(info)
			if time.Since(state.Snapshot.Checked) > time.Hour && info.Eligible {
				info.Eligible = false
				info.Reason = "Check again before updating"
			}
		}
		state.Components = append(state.Components, info)
		// After hub restart the helper still owns the final outcome. Reconcile
		// only started transactions, never dispatch another apply command.
		if m.cancel == nil && state.Job != nil && state.Job.Active {
			for i := range state.Job.Items {
				item := &state.Job.Items[i]
				if item.Component.ID != info.ID {
					continue
				}
				if activePhase(item.Result.Phase) {
					if result, err := target.Status(ctx, item.Transaction); err == nil {
						item.Result = result
					}
				} else if item.Result.Phase == "pending" || item.Result.Phase == "downloading" || item.Result.Phase == "verifying" || item.Result.Phase == "staged" {
					item.Result = Result{Phase: "interrupted", Message: "Update interrupted. Check component before retrying"}
				}
			}
		}
	}
	if m.cancel == nil && state.Job != nil && state.Job.Active {
		state.Job.Active = hasActiveItems(state.Job)
		m.state.Job = state.Job
		_ = m.persist()
	}
	return state
}

func (m *Manager) Start(ctx context.Context, req StartRequest) (*Job, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}
	targets := m.targets()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errors.New("server is shutting down")
	}
	if m.state.Job != nil && m.state.Job.ID == req.ID {
		if m.state.Job.Snapshot != req.Snapshot || len(req.Targets) != len(m.state.Job.Items) {
			return nil, errors.New("update request ID already used")
		}
		for _, item := range m.state.Job.Items {
			if !slices.Contains(req.Targets, item.Component.ID) {
				return nil, errors.New("update request ID already used")
			}
		}
		return cloneStatus(m.state).Job, nil
	}
	if m.state.Job != nil && m.state.Job.Active {
		return nil, errors.New("another update is running")
	}
	if m.state.Job != nil {
		for _, item := range m.state.Job.Items {
			if item.Result.Phase == "interrupted" {
				return nil, errors.New("cancel interrupted update before starting another")
			}
		}
	}
	if _, err := os.Stat(filepath.Join(m.dir, "requests", req.ID+".json")); err == nil {
		return nil, errors.New("update request ID already used")
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	snapshot := m.state.Snapshot
	if snapshot == nil || snapshot.ID != req.Snapshot || time.Since(snapshot.Checked) > time.Hour {
		return nil, errors.New("check for updates again before installing")
	}
	job := &Job{
		ID:       req.ID,
		Snapshot: req.Snapshot,
		Version:  snapshot.Release.Tag,
		Created:  time.Now().UTC(),
		Active:   true,
		Items:    []Item{},
	}
	selected := []Target{}
	for _, id := range req.Targets {
		found := false
		for _, target := range targets {
			info := target.Info(ctx)
			if info.ID != id {
				continue
			}
			info = snapshot.Release.offered(info)
			if !info.Eligible {
				return nil, fmt.Errorf("%s: %s", info.Name, info.Reason)
			}
			selected = append(selected, target)
			job.Items = append(job.Items, Item{
				Component:   info,
				Transaction: newID(),
				Result:      Result{Phase: "pending"},
			})
			found = true
			break
		}
		if !found {
			return nil, errors.New("selected component is unavailable")
		}
	}
	// Stage and apply agents before speech, with the hub last.
	order := func(kind string) int {
		switch kind {
		case "server":
			return 2
		case "speech":
			return 1
		default:
			return 0
		}
	}
	for i := range job.Items {
		for j := i + 1; j < len(job.Items); j++ {
			if order(job.Items[j].Component.Kind) < order(job.Items[i].Component.Kind) {
				job.Items[i], job.Items[j] = job.Items[j], job.Items[i]
				selected[i], selected[j] = selected[j], selected[i]
			}
		}
	}
	m.state.Job = job
	if err := save(filepath.Join(m.dir, "requests", req.ID+".json"), req); err != nil {
		m.state.Job = nil
		return nil, err
	}
	if err := m.persist(); err != nil {
		m.state.Job = nil
		return nil, err
	}
	runCtx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	m.cancel = cancel
	m.done = make(chan struct{})
	go m.run(runCtx, *snapshot, selected, *cloneStatus(m.state).Job)
	return cloneStatus(m.state).Job, nil
}

func (m *Manager) setResult(index int, result Result) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state.Job.Items[index].Result = result
	return m.persist()
}

func hasActiveItems(job *Job) bool {
	return slices.ContainsFunc(job.Items, func(item Item) bool {
		return activePhase(item.Result.Phase)
	})
}

func (m *Manager) beginInstall(ctx context.Context, index int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	m.state.Job.Items[index].Result = Result{Phase: "starting"}
	return m.persist()
}

func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	if m.cancel != nil {
		m.cancel()
	}
	done := m.done
	m.mu.Unlock()
	if done != nil {
		<-done
	}
}

func (m *Manager) run(ctx context.Context, snapshot Snapshot, targets []Target, job Job) {
	staged := make([]bool, len(targets))
	defer func() {
		defer close(m.done)
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for i, target := range targets {
			if staged[i] {
				if err := target.Cancel(cleanup, job.Items[i].Transaction); err != nil && !errors.Is(err, os.ErrNotExist) {
					_ = m.setResult(i, Result{Phase: "interrupted", Message: "Reconnect component and cancel staged update before retrying"})
				}
			}
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		m.cancel()
		m.cancel = nil
		for i := range m.state.Job.Items {
			item := &m.state.Job.Items[i]
			if item.Result.Phase == "pending" || item.Result.Phase == "staged" {
				item.Result = Result{Phase: "cancelled", Message: "Batch stopped before installation"}
			}
		}
		m.state.Job.Active = hasActiveItems(m.state.Job)
		_ = m.persist()
		_ = os.RemoveAll(filepath.Join(m.dir, "downloads", job.ID))
	}()
	for i, target := range targets {
		if ctx.Err() != nil {
			return
		}
		if err := m.setResult(i, Result{Phase: "downloading"}); err != nil {
			return
		}
		pkg, err := m.source.Download(ctx, snapshot.Release, job.Items[i].Component, filepath.Join(m.dir, "downloads", job.ID))
		if err == nil {
			err = m.setResult(i, Result{Phase: "verifying"})
		}
		if err == nil {
			// Stage may finish even when its reply is lost. Cleanup checks the
			// transaction phase and never cancels an installation in progress.
			staged[i] = true
			err = target.Stage(ctx, job.Items[i].Transaction, pkg)
		}
		if err != nil {
			_ = m.setResult(i, Result{Phase: "failed", Message: err.Error()})
			return
		}
		staged[i] = true
		if err := m.setResult(i, Result{Phase: "staged"}); err != nil {
			return
		}
	}
	for i, target := range targets {
		if ctx.Err() != nil {
			return
		}
		if err := m.beginInstall(ctx, i); err != nil {
			return
		}
		staged[i] = false
		if err := target.Apply(ctx, job.Items[i].Transaction); err != nil {
			// Apply is never replayed. Query the transaction to distinguish a
			// rejected request from a helper whose connection was interrupted.
			_ = m.setResult(i, Result{Phase: "awaiting-reconnect", Message: err.Error()})
			m.wait(ctx, target, i, job.Items[i])
			return
		}
		if !m.wait(ctx, target, i, job.Items[i]) {
			return
		}
	}
}

func (m *Manager) wait(ctx context.Context, target Target, index int, item Item) bool {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		result, err := target.Status(ctx, item.Transaction)
		if err == nil {
			if result.Phase == "staged" {
				result = Result{Phase: "interrupted", Message: "Installation did not start. Cancel staged update before retrying"}
			}
			if err := m.setResult(index, result); err != nil {
				return false
			}
			switch result.Phase {
			case "updated":
				return true
			case "failed", "rolled-back", "rollback-failed", "interrupted", "cancelled":
				return false
			}
		}
		select {
		case <-ctx.Done():
			_ = m.setResult(index, Result{Phase: "awaiting-reconnect", Message: "Waiting for component update result"})
			return false
		case <-ticker.C:
		}
	}
}

func (m *Manager) Cancel(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state.Job == nil || m.state.Job.ID != id {
		return errors.New("no cancellable update")
	}
	if m.cancel == nil {
		return m.cancelInterrupted(ctx)
	}
	for _, item := range m.state.Job.Items {
		if activePhase(item.Result.Phase) || item.Result.Phase == "updated" {
			return errors.New("installation has already started")
		}
	}
	m.cancel()
	return nil
}

func (m *Manager) cancelInterrupted(ctx context.Context) error {
	targets := m.targets()
	for index := range m.state.Job.Items {
		item := &m.state.Job.Items[index]
		if item.Result.Phase != "interrupted" {
			continue
		}
		found := false
		for _, target := range targets {
			if target.Info(ctx).ID != item.Component.ID {
				continue
			}
			found = true
			result, err := target.Status(ctx, item.Transaction)
			if errors.Is(err, os.ErrNotExist) {
				if cancelErr := target.Cancel(ctx, item.Transaction); cancelErr != nil && !errors.Is(cancelErr, os.ErrNotExist) {
					return cancelErr
				}
				item.Result = Result{Phase: "cancelled"}
				break
			}
			if err != nil {
				return err
			}
			if result.Phase == "staged" {
				if err := target.Cancel(ctx, item.Transaction); err != nil {
					return err
				}
				result = Result{Phase: "cancelled"}
			}
			item.Result = result
			break
		}
		if !found {
			return errors.New("component must reconnect before cleanup")
		}
	}
	m.state.Job.Active = hasActiveItems(m.state.Job)
	return m.persist()
}
