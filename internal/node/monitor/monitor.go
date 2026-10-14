// Package monitor polls tmux for changes the browser cannot see in the pty
// byte stream. It is the Go port of the relay session-monitor.ts.
//
// Two polls run, each on its own goroutine:
//
//   - The session poll lists every session every SessionPoll. A name that
//     disappears fires OnSessionExit, a new name fires OnSessionCreated. The
//     first poll announces every session that exists. A name that
//     disappears while its session id shows up under a new name fires
//     OnSessionRenamed instead, made anywhere: the browser, a tmux key or a
//     shell. No tmux server means no sessions, so every known session counts
//     as exited. After the first good poll, any change to the names, ids,
//     window counts or attached flags fires OnSessionsChanged with the whole
//     list. Activity is left out, it moves with every burst of output.
//   - The window poll lists the windows and every pane of each watched
//     session every WindowPoll and fires OnWindowsChanged when the layout
//     signature moves. The first signature of a session only seeds the
//     baseline, because the browser fetched its own lists on attach.
//
// The monitor does not filter the hidden __tmuxde_ sessions. The caller does
// that before it broadcasts. It never reports session activity either. The
// relay defined session:activity but never sent it.
package monitor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"tmuxde/internal/protocol"
)

// Default poll intervals, from the relay. Sessions are listed less often than
// the windows of attached ones. Pane focus and folder changes should reach the
// browser at once.
const (
	DefaultSessionPoll = 5 * time.Second
	DefaultWindowPoll  = time.Second
)

// ErrStarted means Start ran twice. A Monitor runs once.
var ErrStarted = errors.New("monitor: already started")

// Source lists what tmux has. The tmux client satisfies it. Every method
// takes the poll context, which Stop cancels.
type Source interface {
	// ListSessions lists every session. It returns an empty list and no
	// error when no tmux server runs.
	ListSessions(ctx context.Context) ([]protocol.SessionInfo, error)
	// ListWindows lists the windows of one session.
	ListWindows(ctx context.Context, session string) ([]protocol.WindowInfo, error)
	// ListPanes lists the panes of one window. An empty windowID means every
	// pane of the session.
	ListPanes(ctx context.Context, session, windowID string) ([]protocol.PaneInfo, error)
}

// Ticker delivers ticks on C. It is the part of *time.Ticker the monitor
// uses.
type Ticker interface {
	C() <-chan time.Time
	Stop()
}

// Clock makes tickers. Tests pass a fake one to drive the polls by hand.
type Clock interface {
	NewTicker(d time.Duration) Ticker
}

// Options configures New. Zero values pick the defaults.
type Options struct {
	// SessionPoll is the session poll interval. Zero or less means
	// DefaultSessionPoll.
	SessionPoll time.Duration
	// WindowPoll is the window poll interval. Zero or less means
	// DefaultWindowPoll.
	WindowPoll time.Duration
	// Watched returns the names of the sessions some connection is attached
	// to. Only those get the window poll. Nil watches nothing. It runs on the
	// window poll goroutine.
	Watched func() []string
	// Logger gets monitor records. Default slog.Default().
	Logger *slog.Logger
	// Clock makes the poll tickers. Default is the real clock.
	Clock Clock

	// OnSessionExit runs when a known session is gone.
	OnSessionExit func(name string)
	// OnSessionCreated runs for every session seen for the first time.
	OnSessionCreated func(session protocol.SessionInfo)
	// OnSessionRenamed runs when a known session kept its id under a new
	// name. Neither OnSessionExit nor OnSessionCreated runs for it.
	OnSessionRenamed func(oldName, newName string)
	// OnSessionsChanged runs after the other session callbacks of a poll
	// when the listing differs from the last good one in a name, an id, a
	// window count or an attached flag. sessions is the fresh list and never
	// nil. The first good poll only sets the baseline.
	OnSessionsChanged func(sessions []protocol.SessionInfo)
	// OnWindowsChanged runs when the windows or panes of a watched session
	// changed. windows is the fresh window list and never nil.
	OnWindowsChanged func(name string, windows []protocol.WindowInfo)
}

// pollKind names one of the two polls.
type pollKind int

const (
	sessionPoll pollKind = iota
	windowPoll
)

func (k pollKind) String() string {
	if k == sessionPoll {
		return "session"
	}
	return "window"
}

// Monitor polls tmux and reports changes through callbacks.
//
// Session callbacks run on the session poll goroutine and the window
// callback on the window poll goroutine, so the two kinds can run at the
// same time. Each kind runs in order, one call at a time. A slow callback
// delays the next poll of its kind. A callback must not call Stop, which
// waits for the goroutine that runs the callback. A callback that panics is
// recovered and logged, and the poll goes on.
type Monitor struct {
	src         Source
	log         *slog.Logger
	clock       Clock
	watched     func() []string
	sessionPoll time.Duration
	windowPoll  time.Duration

	cbMu      sync.Mutex
	onExit    func(name string)
	onCreated func(session protocol.SessionInfo)
	onRenamed func(oldName, newName string)
	onList    func(sessions []protocol.SessionInfo)
	onWindows func(name string, windows []protocol.WindowInfo)

	// known maps each session name seen by the last good session poll to
	// its tmux id, hidden sessions included. Only the session poll
	// goroutine uses it.
	known map[string]string
	// listSig is the signature of the last good session listing, "" before
	// the first one. Only the session poll goroutine uses it.
	listSig string
	// listed reports that a good session listing set listSig.
	listed bool
	// sigs holds the layout signature of each watched session. Only the
	// window poll goroutine uses it.
	sigs map[string]string

	runMu   sync.Mutex
	started bool
	stopped bool
	cancel  context.CancelFunc
	wg      sync.WaitGroup

	// afterPoll runs on the poll goroutine after every poll, once a tick
	// that came in during the poll is dropped. Tests set it to wait for a
	// poll to finish.
	afterPoll func(pollKind)
}

// New returns a monitor that reads src. It does not poll until Start.
// src must not be nil.
func New(src Source, opts Options) *Monitor {
	if src == nil {
		panic("monitor: nil Source")
	}
	if opts.SessionPoll <= 0 {
		opts.SessionPoll = DefaultSessionPoll
	}
	if opts.WindowPoll <= 0 {
		opts.WindowPoll = DefaultWindowPoll
	}
	if opts.Watched == nil {
		opts.Watched = func() []string { return nil }
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Clock == nil {
		opts.Clock = realClock{}
	}
	return &Monitor{
		src:         src,
		log:         opts.Logger,
		clock:       opts.Clock,
		watched:     opts.Watched,
		sessionPoll: opts.SessionPoll,
		windowPoll:  opts.WindowPoll,
		onExit:      opts.OnSessionExit,
		onCreated:   opts.OnSessionCreated,
		onRenamed:   opts.OnSessionRenamed,
		onList:      opts.OnSessionsChanged,
		onWindows:   opts.OnWindowsChanged,
		known:       map[string]string{},
		sigs:        map[string]string{},
	}
}

// OnSessionExit replaces the session exit callback. Nil removes it.
func (m *Monitor) OnSessionExit(fn func(name string)) {
	m.cbMu.Lock()
	m.onExit = fn
	m.cbMu.Unlock()
}

// OnSessionCreated replaces the session created callback. Nil removes it.
func (m *Monitor) OnSessionCreated(fn func(session protocol.SessionInfo)) {
	m.cbMu.Lock()
	m.onCreated = fn
	m.cbMu.Unlock()
}

// OnSessionRenamed replaces the session renamed callback. Nil removes it.
func (m *Monitor) OnSessionRenamed(fn func(oldName, newName string)) {
	m.cbMu.Lock()
	m.onRenamed = fn
	m.cbMu.Unlock()
}

// OnSessionsChanged replaces the session list callback. Nil removes it.
func (m *Monitor) OnSessionsChanged(fn func(sessions []protocol.SessionInfo)) {
	m.cbMu.Lock()
	m.onList = fn
	m.cbMu.Unlock()
}

// OnWindowsChanged replaces the windows changed callback. Nil removes it.
func (m *Monitor) OnWindowsChanged(fn func(name string, windows []protocol.WindowInfo)) {
	m.cbMu.Lock()
	m.onWindows = fn
	m.cbMu.Unlock()
}

// Start runs both polls at once and then on their intervals until ctx ends
// or Stop runs. It returns at once. The polls run on their own goroutines.
func (m *Monitor) Start(ctx context.Context) error {
	m.runMu.Lock()
	defer m.runMu.Unlock()
	if m.started {
		return ErrStarted
	}
	m.started = true
	ctx, m.cancel = context.WithCancel(ctx)
	sessions := m.clock.NewTicker(m.sessionPoll)
	windows := m.clock.NewTicker(m.windowPoll)
	m.wg.Go(func() { m.run(ctx, sessionPoll, sessions, m.pollSessions) })
	m.wg.Go(func() { m.run(ctx, windowPoll, windows, m.pollWindows) })
	m.log.Info("session monitor started", "sessionPoll", m.sessionPoll, "windowPoll", m.windowPoll)
	return nil
}

// Stop ends both polls and waits until they return, callbacks included.
// It is safe to call more than once and before Start.
func (m *Monitor) Stop() {
	m.runMu.Lock()
	cancel := m.cancel
	first := cancel != nil && !m.stopped
	if cancel != nil {
		m.stopped = true
	}
	m.runMu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	m.wg.Wait()
	if first {
		m.log.Info("session monitor stopped")
	}
}

// run polls once, then once per tick until ctx ends.
func (m *Monitor) run(ctx context.Context, kind pollKind, t Ticker, poll func(context.Context)) {
	defer t.Stop()
	for ctx.Err() == nil {
		poll(ctx)
		// One goroutine per kind already keeps two polls apart. A tick that
		// came in while the poll ran is dropped as well, so a slow tmux does
		// not get polls back to back. The relay skipped such ticks too.
		select {
		case <-t.C():
		default:
		}
		if m.afterPoll != nil {
			m.afterPoll(kind)
		}
		select {
		case <-ctx.Done():
		case <-t.C():
		}
	}
}

// protect runs fn and recovers a panic. It logs the panic and reports
// false, so one broken callback or source cannot end a poll goroutine.
func (m *Monitor) protect(what string, fn func()) (ok bool) {
	defer func() {
		if p := recover(); p != nil {
			m.log.Error("session monitor recovered panic", "in", what,
				"panic", fmt.Sprint(p), "stack", string(debug.Stack()))
			ok = false
		}
	}()
	fn()
	return true
}

func (m *Monitor) emitExit(name string) {
	m.cbMu.Lock()
	fn := m.onExit
	m.cbMu.Unlock()
	if fn != nil {
		m.protect("OnSessionExit", func() { fn(name) })
	}
}

func (m *Monitor) emitCreated(session protocol.SessionInfo) {
	m.cbMu.Lock()
	fn := m.onCreated
	m.cbMu.Unlock()
	if fn != nil {
		m.protect("OnSessionCreated", func() { fn(session) })
	}
}

func (m *Monitor) emitRenamed(oldName, newName string) {
	m.cbMu.Lock()
	fn := m.onRenamed
	m.cbMu.Unlock()
	if fn != nil {
		m.protect("OnSessionRenamed", func() { fn(oldName, newName) })
	}
}

func (m *Monitor) emitList(sessions []protocol.SessionInfo) {
	m.cbMu.Lock()
	fn := m.onList
	m.cbMu.Unlock()
	if fn != nil {
		m.protect("OnSessionsChanged", func() { fn(sessions) })
	}
}

func (m *Monitor) emitWindows(name string, windows []protocol.WindowInfo) {
	m.cbMu.Lock()
	fn := m.onWindows
	m.cbMu.Unlock()
	if fn != nil {
		m.protect("OnWindowsChanged", func() { fn(name, windows) })
	}
}

// realClock makes time.Ticker tickers.
type realClock struct{}

func (realClock) NewTicker(d time.Duration) Ticker { return realTicker{time.NewTicker(d)} }

type realTicker struct{ t *time.Ticker }

func (r realTicker) C() <-chan time.Time { return r.t.C }
func (r realTicker) Stop()               { r.t.Stop() }
