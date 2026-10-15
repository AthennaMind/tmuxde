package monitor

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"tmuxde/internal/protocol"
)

// waitLimit bounds every wait in these tests. Nothing here should take
// longer than a few milliseconds.
const waitLimit = 5 * time.Second

// fakeSource is a Source the tests set by hand. It records every call.
type fakeSource struct {
	mu        sync.Mutex
	sessions  []protocol.SessionInfo
	sessErr   error
	windows   []protocol.WindowInfo
	panes     []protocol.PaneInfo
	layoutErr error
	calls     []string
	inFlight  int
	maxFlight int
	// hold, when set, runs first in every call. Tests block in it.
	hold func(ctx context.Context, method string)
}

func (s *fakeSource) enter(ctx context.Context, method, call string) func() {
	s.mu.Lock()
	s.calls = append(s.calls, call)
	hold := s.hold
	if method == "ListWindows" {
		s.inFlight++
		s.maxFlight = max(s.maxFlight, s.inFlight)
	}
	s.mu.Unlock()
	if hold != nil {
		hold(ctx, method)
	}
	return func() {
		if method == "ListWindows" {
			s.mu.Lock()
			s.inFlight--
			s.mu.Unlock()
		}
	}
}

func (s *fakeSource) ListSessions(ctx context.Context) ([]protocol.SessionInfo, error) {
	defer s.enter(ctx, "ListSessions", "sessions")()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessErr != nil {
		return nil, s.sessErr
	}
	return slices.Clone(s.sessions), nil
}

func (s *fakeSource) ListWindows(ctx context.Context, session string) ([]protocol.WindowInfo, error) {
	defer s.enter(ctx, "ListWindows", "windows:"+session)()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.layoutErr != nil {
		return nil, s.layoutErr
	}
	return slices.Clone(s.windows), nil
}

func (s *fakeSource) ListPanes(ctx context.Context, session, windowID string) ([]protocol.PaneInfo, error) {
	defer s.enter(ctx, "ListPanes", "panes:"+session+":"+windowID)()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.layoutErr != nil {
		return nil, s.layoutErr
	}
	return slices.Clone(s.panes), nil
}

func (s *fakeSource) setSessions(sessions []protocol.SessionInfo, err error) {
	s.mu.Lock()
	s.sessions, s.sessErr = sessions, err
	s.mu.Unlock()
}

func (s *fakeSource) setWindows(windows ...protocol.WindowInfo) {
	s.mu.Lock()
	s.windows = windows
	s.mu.Unlock()
}

func (s *fakeSource) setPanes(panes ...protocol.PaneInfo) {
	s.mu.Lock()
	s.panes = panes
	s.mu.Unlock()
}

func (s *fakeSource) setLayoutErr(err error) {
	s.mu.Lock()
	s.layoutErr = err
	s.mu.Unlock()
}

func (s *fakeSource) setHold(hold func(ctx context.Context, method string)) {
	s.mu.Lock()
	s.hold = hold
	s.mu.Unlock()
}

// count reports how many calls start with prefix.
func (s *fakeSource) count(prefix string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, c := range s.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func (s *fakeSource) callLog() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.calls)
}

func (s *fakeSource) maxInFlight() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.maxFlight
}

// fakeClock makes tickers that tick only when a test fires them.
type fakeClock struct {
	mu      sync.Mutex
	now     time.Duration
	tickers []*fakeTicker
}

func (c *fakeClock) NewTicker(d time.Duration) Ticker {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTicker{period: d, next: c.now + d, c: make(chan time.Time, 1)}
	c.tickers = append(c.tickers, t)
	return t
}

// ticker returns the ticker with period d.
func (c *fakeClock) ticker(t *testing.T, d time.Duration) *fakeTicker {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, tk := range c.tickers {
		if tk.period == d {
			return tk
		}
	}
	t.Fatalf("no ticker with period %v", d)
	return nil
}

func (c *fakeClock) periods() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []time.Duration
	for _, tk := range c.tickers {
		out = append(out, tk.period)
	}
	slices.Sort(out)
	return out
}

// fakeTicker queues one tick and drops the rest, like a real ticker.
type fakeTicker struct {
	period time.Duration
	next   time.Duration // guarded by fakeClock.mu
	c      chan time.Time

	mu      sync.Mutex
	stopped bool
}

func (t *fakeTicker) C() <-chan time.Time { return t.c }

func (t *fakeTicker) Stop() {
	t.mu.Lock()
	t.stopped = true
	t.mu.Unlock()
}

// fire sends one tick and reports whether it was queued.
func (t *fakeTicker) fire() bool {
	select {
	case t.c <- time.Time{}:
		return true
	default:
		return false
	}
}

func (t *fakeTicker) isStopped() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.stopped
}

// logBuffer collects log output. slog handlers write from any goroutine.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *logBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// recorder keeps every callback as one line, in order.
type recorder struct {
	mu      sync.Mutex
	events  []string
	windows [][]protocol.WindowInfo
}

func (r *recorder) add(event string) {
	r.mu.Lock()
	r.events = append(r.events, event)
	r.mu.Unlock()
}

func (r *recorder) got() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.events)
}

func (r *recorder) lastWindows() []protocol.WindowInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.windows) == 0 {
		return nil
	}
	return r.windows[len(r.windows)-1]
}

func (r *recorder) exit(name string) { r.add("exit:" + name) }

func (r *recorder) created(s protocol.SessionInfo) {
	r.add(fmt.Sprintf("created:%s(%s)", s.Name, s.ID))
}

func (r *recorder) renamed(oldName, newName string) {
	r.add("renamed:" + oldName + ">" + newName)
}

// listChanged records the names with their window counts, as name/windows.
func (r *recorder) listChanged(sessions []protocol.SessionInfo) {
	parts := make([]string, 0, len(sessions))
	for _, s := range sessions {
		parts = append(parts, fmt.Sprintf("%s/%d", s.Name, s.Windows))
	}
	r.add("list:" + strings.Join(parts, ","))
}

func (r *recorder) windowsChanged(name string, windows []protocol.WindowInfo) {
	r.mu.Lock()
	r.windows = append(r.windows, windows)
	r.mu.Unlock()
	r.add("windows:" + name)
}

// harness runs one Monitor on a fake clock. Every poll reports on polled
// once it is done, so a test knows when a tick has been handled.
type harness struct {
	t      *testing.T
	src    *fakeSource
	clock  *fakeClock
	m      *Monitor
	rec    *recorder
	logs   *logBuffer
	polled chan pollKind
}

// newHarness builds the monitor. Callbacks left nil in opts go to the
// recorder.
func newHarness(t *testing.T, src *fakeSource, opts Options) *harness {
	t.Helper()
	h := &harness{
		t:      t,
		src:    src,
		clock:  &fakeClock{},
		rec:    &recorder{},
		logs:   &logBuffer{},
		polled: make(chan pollKind, 64),
	}
	opts.Clock = h.clock
	opts.Logger = slog.New(slog.NewTextHandler(h.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	if opts.OnSessionExit == nil {
		opts.OnSessionExit = h.rec.exit
	}
	if opts.OnSessionCreated == nil {
		opts.OnSessionCreated = h.rec.created
	}
	if opts.OnSessionRenamed == nil {
		opts.OnSessionRenamed = h.rec.renamed
	}
	if opts.OnSessionsChanged == nil {
		opts.OnSessionsChanged = h.rec.listChanged
	}
	if opts.OnWindowsChanged == nil {
		opts.OnWindowsChanged = h.rec.windowsChanged
	}
	h.m = New(src, opts)
	h.m.afterPoll = func(k pollKind) { h.polled <- k }
	return h
}

// start starts the monitor and waits for the first two polls.
func (h *harness) start() {
	h.t.Helper()
	if err := h.m.Start(h.t.Context()); err != nil {
		h.t.Fatalf("Start: %v", err)
	}
	h.t.Cleanup(h.m.Stop)
	h.waitPolls(sessionPoll, windowPoll)
}

// waitPolls waits until one poll of each given kind has finished.
func (h *harness) waitPolls(kinds ...pollKind) {
	h.t.Helper()
	want := slices.Clone(kinds)
	deadline := time.After(waitLimit)
	for len(want) > 0 {
		select {
		case k := <-h.polled:
			i := slices.Index(want, k)
			if i < 0 {
				h.t.Fatalf("%v poll finished, want one of %v", k, want)
			}
			want = slices.Delete(want, i, i+1)
		case <-deadline:
			h.t.Fatalf("polls %v did not finish within %v", want, waitLimit)
		}
	}
}

// advance moves the fake clock by d. Every tick that falls due fires in
// time order, and advance waits for its poll before the next one.
func (h *harness) advance(d time.Duration) {
	h.t.Helper()
	h.clock.mu.Lock()
	end := h.clock.now + d
	h.clock.mu.Unlock()
	for {
		h.clock.mu.Lock()
		var due *fakeTicker
		for _, tk := range h.clock.tickers {
			if tk.next <= end && (due == nil || tk.next < due.next) {
				due = tk
			}
		}
		if due != nil {
			h.clock.now = due.next
			due.next += due.period
		}
		h.clock.mu.Unlock()
		if due == nil {
			break
		}
		if !due.fire() {
			h.t.Fatalf("tick of the %v ticker dropped, a poll still runs", due.period)
		}
		h.waitPolls(h.kindOf(due))
	}
	h.clock.mu.Lock()
	h.clock.now = end
	h.clock.mu.Unlock()
}

func (h *harness) kindOf(t *fakeTicker) pollKind {
	h.t.Helper()
	if h.m.sessionPoll == h.m.windowPoll {
		h.t.Fatal("harness needs different poll intervals")
	}
	if t.period == h.m.sessionPoll {
		return sessionPoll
	}
	return windowPoll
}

// wait blocks on ch until it is closed or ready, or fails the test.
func wait[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(waitLimit):
		t.Fatalf("%s did not happen within %v", what, waitLimit)
		var zero T
		return zero
	}
}

// eventually polls cond until it holds or the wait limit passes.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitLimit)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not happen within %v", what, waitLimit)
		}
		time.Sleep(time.Millisecond)
	}
}

func session(name, id string) protocol.SessionInfo {
	return protocol.SessionInfo{
		Name:     name,
		ID:       id,
		Windows:  1,
		Created:  "2026-10-12T00:00:00.000Z",
		Activity: "2026-10-12T00:00:00.000Z",
	}
}

func withWindows(s protocol.SessionInfo, n int) protocol.SessionInfo {
	s.Windows = n
	return s
}

func attached(s protocol.SessionInfo) protocol.SessionInfo {
	s.Attached = true
	return s
}

func withActivity(s protocol.SessionInfo, at string) protocol.SessionInfo {
	s.Activity = at
	return s
}

func ptr[T any](v T) *T { return &v }

// window is the relay test WINDOW.
func window() protocol.WindowInfo {
	return protocol.WindowInfo{
		ID:        "@1",
		Index:     0,
		Name:      "shell",
		Active:    true,
		PaneCount: 2,
		Layout:    "layout",
		Activity:  ptr(false),
		Zoomed:    ptr(false),
	}
}

// pane is the relay test pane helper.
func pane(id string, active bool, path string) protocol.PaneInfo {
	var index int
	_, _ = fmt.Sscanf(id[1:], "%d", &index)
	return protocol.PaneInfo{
		ID:         id,
		Index:      index,
		WindowID:   "@1",
		Active:     active,
		Dimensions: protocol.TerminalSize{Cols: 80, Rows: 24},
		Position:   protocol.Position{X: 0, Y: 0},
		Path:       ptr(path),
	}
}

// layoutSource returns a source with the relay test layout: one window and
// two panes, %1 active in /repo.
func layoutSource() *fakeSource {
	src := &fakeSource{}
	src.setWindows(window())
	src.setPanes(pane("%1", true, "/repo"), pane("%2", false, "/other"))
	return src
}

func watch(names ...string) func() []string {
	return func() []string { return slices.Clone(names) }
}
