package update

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"
)

type fakeSource struct {
	checks    int
	downloads int
}

func (s *fakeSource) Check(context.Context) (*Snapshot, error) {
	s.checks++
	return &Snapshot{ID: "snapshot", Checked: time.Now().UTC(), Release: testRelease()}, nil
}

func (s *fakeSource) Download(context.Context, Release, Component, string) (Package, error) {
	s.downloads++
	return Package{}, nil
}

type targetLog struct {
	mu      sync.Mutex
	entries []string
}

func (l *targetLog) add(entry string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, entry)
}

type fakeTarget struct {
	kind       string
	log        *targetLog
	stageError error
	applyError error
	mu         sync.Mutex
	result     Result
}

func (f *fakeTarget) Info(context.Context) Component {
	return Component{
		ID:      f.kind,
		Name:    f.kind,
		Kind:    f.kind,
		Version: "1.0.0",
		OS:      "linux",
		Arch:    "amd64",
		Online:  true,
	}
}

func (f *fakeTarget) Stage(context.Context, string, Package) error {
	f.log.add("stage:" + f.kind)
	return f.stageError
}

func (f *fakeTarget) Apply(context.Context, string) error {
	f.log.add("apply:" + f.kind)
	f.mu.Lock()
	f.result = Result{Phase: "updated"}
	f.mu.Unlock()
	return f.applyError
}

func (f *fakeTarget) Status(context.Context, string) (Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.result, nil
}

func (f *fakeTarget) Cancel(context.Context, string) error {
	f.log.add("cancel:" + f.kind)
	return nil
}

func testManager(t *testing.T, targets ...Target) (*Manager, *fakeSource) {
	t.Helper()
	manager, err := NewManager(t.TempDir(), func() []Target {
		return targets
	})
	if err != nil {
		t.Fatal(err)
	}
	source := &fakeSource{}
	manager.source = source
	t.Cleanup(manager.Close)
	return manager, source
}

func waitJob(t *testing.T, manager *Manager) {
	t.Helper()
	manager.mu.Lock()
	done := manager.done
	manager.mu.Unlock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("update job did not finish")
	}
}

func TestManagerManualCheckAndBatchOrder(t *testing.T) {
	log := &targetLog{}
	server := &fakeTarget{kind: "server", log: log}
	speech := &fakeTarget{kind: "speech", log: log}
	agent := &fakeTarget{kind: "agent", log: log}
	manager, source := testManager(t, server, speech, agent)
	manager.Status(t.Context())
	manager.Status(t.Context())
	if source.checks != 0 || source.downloads != 0 {
		t.Fatal("status performed release discovery")
	}
	if err := manager.Check(t.Context()); err != nil {
		t.Fatal(err)
	}
	request := StartRequest{ID: "request", Snapshot: "snapshot", Targets: []string{"server", "speech", "agent"}}
	if _, err := manager.Start(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	waitJob(t, manager)
	if _, err := manager.Start(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	want := []string{"stage:agent", "stage:speech", "stage:server", "apply:agent", "apply:speech", "apply:server"}
	if !slices.Equal(log.entries, want) {
		t.Fatalf("operations = %v, want %v", log.entries, want)
	}
	if source.checks != 1 || source.downloads != 3 {
		t.Fatalf("checks = %d, downloads = %d", source.checks, source.downloads)
	}
	if state := manager.Status(t.Context()); state.Job.Active {
		t.Fatal("completed job still active")
	}
}

func TestManagerStageFailurePreventsAllInstalls(t *testing.T) {
	log := &targetLog{}
	server := &fakeTarget{kind: "server", log: log, stageError: errors.New("disk full")}
	agent := &fakeTarget{kind: "agent", log: log}
	manager, _ := testManager(t, server, agent)
	if err := manager.Check(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(t.Context(), StartRequest{ID: "request", Snapshot: "snapshot", Targets: []string{"server", "agent"}}); err != nil {
		t.Fatal(err)
	}
	waitJob(t, manager)
	want := []string{"stage:agent", "stage:server", "cancel:agent", "cancel:server"}
	if !slices.Equal(log.entries, want) {
		t.Fatalf("operations = %v, want %v", log.entries, want)
	}
}

func TestManagerDoesNotReplayLostApply(t *testing.T) {
	log := &targetLog{}
	agent := &fakeTarget{kind: "agent", log: log, applyError: errors.New("connection lost")}
	manager, _ := testManager(t, agent)
	if err := manager.Check(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(t.Context(), StartRequest{ID: "request", Snapshot: "snapshot", Targets: []string{"agent"}}); err != nil {
		t.Fatal(err)
	}
	waitJob(t, manager)
	if !slices.Equal(log.entries, []string{"stage:agent", "apply:agent"}) {
		t.Fatalf("operations = %v", log.entries)
	}
	if got := manager.Status(t.Context()).Job.Items[0].Result.Phase; got != "updated" {
		t.Fatalf("phase = %s", got)
	}
}

func TestManagerRestartOnlyReadsStartedTransaction(t *testing.T) {
	log := &targetLog{}
	agent := &fakeTarget{kind: "agent", log: log, result: Result{Phase: "updated"}}
	dir := t.TempDir()
	state := Status{
		Job: &Job{
			ID:     "job",
			Active: true,
			Items:  []Item{{Component: agent.Info(t.Context()), Transaction: "transaction", Result: Result{Phase: "starting"}}},
		},
	}
	if err := save(filepath.Join(dir, "updates", "state.json"), state); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(dir, func() []Target {
		return []Target{agent}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	source := &fakeSource{}
	manager.source = source
	result := manager.Status(t.Context())
	if result.Job.Active || result.Job.Items[0].Result.Phase != "updated" {
		t.Fatalf("recovered job = %+v", result.Job)
	}
	if len(log.entries) != 0 || source.checks != 0 || source.downloads != 0 {
		t.Fatal("restart replayed mutation or checked release")
	}
}
