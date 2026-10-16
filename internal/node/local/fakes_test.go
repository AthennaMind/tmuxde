package local

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"tmuxde/internal/config"
	"tmuxde/internal/node"
	"tmuxde/internal/node/pty"
	"tmuxde/internal/node/tmux"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

var quiet = slog.New(slog.DiscardHandler)

// waitTimeout bounds every wait in these tests. Nothing here sleeps for
// synchronisation. Waits poll a condition or block on a channel.
const waitTimeout = 5 * time.Second

func ptr[T any](v T) *T { return &v }

// fakeTmux records calls and answers from its fields. It is safe for
// concurrent use.
type fakeTmux struct {
	mu    sync.Mutex
	calls []string

	sessions []protocol.SessionInfo
	missing  map[string]bool
	created  protocol.SessionInfo
	windows  []protocol.WindowInfo
	current  string
	// panes lists every pane. ListPanes filters it by window.
	panes      []protocol.PaneInfo
	capture    string
	captureErr error
	paneText   string
	scroll     tmux.ScrollState
	scrollTo   tmux.ScrollState
	state      tmux.ScrollState
	swept      int
	errs       map[string]error
	// noStart is the NoStartFlag answer.
	noStart bool

	// zoomArgs keeps the last ZoomPane arguments.
	zoomArgs struct {
		session, pane string
		desired       *bool
	}
	captureOpts []tmux.CaptureOptions
}

func newFakeTmux() *fakeTmux {
	return &fakeTmux{
		sessions: []protocol.SessionInfo{session("work", "$1"), session("other", "$2")},
		missing:  map[string]bool{},
		windows:  []protocol.WindowInfo{window("@1", 0, true)},
		current:  "@1",
		panes:    []protocol.PaneInfo{pane("%1", "@1")},
		capture:  "REPLAYED SCROLLBACK",
		paneText: "PANE CONTENT",
		scroll:   tmux.ScrollState{Position: 12, HistorySize: 400, PaneHeight: 40, InMode: true},
		scrollTo: tmux.ScrollState{Position: 200, HistorySize: 400, PaneHeight: 40, InMode: true},
		state:    tmux.ScrollState{Position: 0, HistorySize: 400, PaneHeight: 40},
		errs:     map[string]error{},
	}
}

func (f *fakeTmux) record(method string, args ...any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	parts := []string{method}
	for _, a := range args {
		parts = append(parts, fmt.Sprint(a))
	}
	f.calls = append(f.calls, strings.Join(parts, " "))
	return f.errs[method]
}

func (f *fakeTmux) set(fn func(f *fakeTmux)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

// called lists the recorded calls of method, each as "method arg arg".
func (f *fakeTmux) called(method string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		if c == method || strings.HasPrefix(c, method+" ") {
			out = append(out, c)
		}
	}
	return out
}

func (f *fakeTmux) Version(context.Context) (string, error) {
	if err := f.record("Version"); err != nil {
		return "", err
	}
	return "tmux 3.3a", nil
}

func (f *fakeTmux) ListSessions(context.Context) ([]protocol.SessionInfo, error) {
	err := f.record("ListSessions")
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.sessions), err
}

func (f *fakeTmux) CreateSession(_ context.Context, name, cwd, command string) (protocol.SessionInfo, error) {
	err := f.record("CreateSession", name, cwd, command)
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.created, err
}

func (f *fakeTmux) KillSession(_ context.Context, name string) error {
	return f.record("KillSession", name)
}

func (f *fakeTmux) RenameSession(_ context.Context, oldName, newName string) error {
	return f.record("RenameSession", oldName, newName)
}

func (f *fakeTmux) SessionExists(_ context.Context, name string) bool {
	_ = f.record("SessionExists", name)
	f.mu.Lock()
	defer f.mu.Unlock()
	return !f.missing[name]
}

func (f *fakeTmux) ListWindows(_ context.Context, s string) ([]protocol.WindowInfo, error) {
	err := f.record("ListWindows", s)
	f.mu.Lock()
	defer f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return slices.Clone(f.windows), nil
}

func (f *fakeTmux) StepWindow(_ context.Context, s string, delta int) error {
	return f.record("StepWindow", s, delta)
}

func (f *fakeTmux) CreateWindow(_ context.Context, s, name string) error {
	return f.record("CreateWindow", s, name)
}

func (f *fakeTmux) SelectWindow(_ context.Context, id string) error {
	return f.record("SelectWindow", id)
}

func (f *fakeTmux) KillWindow(_ context.Context, id string) error {
	return f.record("KillWindow", id)
}

func (f *fakeTmux) RenameWindow(_ context.Context, id, name string) error {
	return f.record("RenameWindow", id, name)
}

func (f *fakeTmux) SelectLayout(_ context.Context, s, preset string) error {
	return f.record("SelectLayout", s, preset)
}

func (f *fakeTmux) RotateLayout(_ context.Context, s string) error {
	return f.record("RotateLayout", s)
}

func (f *fakeTmux) ListPanes(_ context.Context, s, windowID string) ([]protocol.PaneInfo, error) {
	err := f.record("ListPanes", s, windowID)
	f.mu.Lock()
	defer f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	var out []protocol.PaneInfo
	for _, p := range f.panes {
		if windowID == "" || p.WindowID == windowID {
			out = append(out, p)
		}
	}
	return out, nil
}

func (f *fakeTmux) CurrentWindowPanes(ctx context.Context, s string) (string, []protocol.PaneInfo, error) {
	if err := f.record("CurrentWindowPanes", s); err != nil {
		return "", nil, err
	}
	f.mu.Lock()
	wid := f.current
	f.mu.Unlock()
	panes, err := f.ListPanes(ctx, s, wid)
	return wid, panes, err
}

func (f *fakeTmux) SplitPane(_ context.Context, s, direction string) error {
	return f.record("SplitPane", s, direction)
}

func (f *fakeTmux) SelectPane(_ context.Context, s, id string) error {
	return f.record("SelectPane", s, id)
}

func (f *fakeTmux) StepPane(_ context.Context, s string, delta int) error {
	return f.record("StepPane", s, delta)
}

func (f *fakeTmux) ZoomPane(_ context.Context, s, id string, desired *bool) error {
	err := f.record("ZoomPane", s, id)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.zoomArgs.session, f.zoomArgs.pane = s, id
	f.zoomArgs.desired = nil
	if desired != nil {
		f.zoomArgs.desired = ptr(*desired)
	}
	return err
}

func (f *fakeTmux) ResizePane(_ context.Context, id, direction string, amount int) error {
	return f.record("ResizePane", id, direction, amount)
}

func (f *fakeTmux) KillPane(_ context.Context, id string) error {
	return f.record("KillPane", id)
}

func (f *fakeTmux) SwapPane(_ context.Context, id, direction string) error {
	return f.record("SwapPane", id, direction)
}

func (f *fakeTmux) SwapPanes(_ context.Context, id, target string) error {
	return f.record("SwapPanes", id, target)
}

func (f *fakeTmux) JoinPane(_ context.Context, id, windowID, direction string) error {
	return f.record("JoinPane", id, windowID, direction)
}

func (f *fakeTmux) BreakPane(_ context.Context, s, id string) error {
	return f.record("BreakPane", s, id)
}

func (f *fakeTmux) CapturePane(_ context.Context, s string, opts tmux.CaptureOptions) (string, error) {
	_ = f.record("CapturePane", s)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.captureOpts = append(f.captureOpts, opts)
	return f.capture, f.captureErr
}

func (f *fakeTmux) CapturePaneByID(_ context.Context, id string, opts tmux.CaptureOptions) (string, error) {
	err := f.record("CapturePaneByID", id)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.captureOpts = append(f.captureOpts, opts)
	return f.paneText, err
}

func (f *fakeTmux) SendPrefix(_ context.Context, s string) error {
	return f.record("SendPrefix", s)
}

func (f *fakeTmux) SendInterrupt(_ context.Context, s string) error {
	return f.record("SendInterrupt", s)
}

func (f *fakeTmux) EnterCopyMode(_ context.Context, s string) error {
	return f.record("EnterCopyMode", s)
}

func (f *fakeTmux) ExitCopyMode(_ context.Context, s string) error {
	return f.record("ExitCopyMode", s)
}

func (f *fakeTmux) ReadScrollState(_ context.Context, s string) (tmux.ScrollState, error) {
	err := f.record("ReadScrollState", s)
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state, err
}

func (f *fakeTmux) ScrollHistory(_ context.Context, s string, lines int) (tmux.ScrollState, error) {
	err := f.record("ScrollHistory", s, lines)
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.scroll, err
}

func (f *fakeTmux) ScrollToPosition(_ context.Context, s string, position int) (tmux.ScrollState, error) {
	err := f.record("ScrollToPosition", s, position)
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.scrollTo, err
}

// NoStartFlag is not recorded. It is a cached probe, not a tmux command
// of the handler.
func (f *fakeTmux) NoStartFlag(context.Context) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.noStart
}

func (f *fakeTmux) SweepOrphanClones(context.Context) int {
	_ = f.record("SweepOrphanClones")
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.swept
}

func session(name, id string) protocol.SessionInfo {
	at := time.Unix(0, 0).UTC().Format(time.RFC3339)
	return protocol.SessionInfo{Name: name, ID: id, Windows: 1, Created: at, Activity: at}
}

func pane(id, windowID string) protocol.PaneInfo {
	return protocol.PaneInfo{
		ID:         id,
		WindowID:   windowID,
		Active:     true,
		Dimensions: protocol.TerminalSize{Cols: 80, Rows: 24},
	}
}

func window(id string, index int, active bool) protocol.WindowInfo {
	return protocol.WindowInfo{ID: id, Index: index, Name: "bash", Active: active, PaneCount: 1}
}

// fakeBridge stands in for *pty.Bridge. Tests drive ready, output and the
// end by hand.
type fakeBridge struct {
	session string
	out     chan string
	ready   chan struct{}
	done    chan struct{}
	// stop is closed by Close. emit and a blocking write give up then.
	stop chan struct{}
	// stuck makes Close leave the bridge running, as a tmux client that
	// ignores the hangup would for a while.
	stuck bool
	// readyOnClose fires ready inside Close, as tmux output that arrives
	// at the moment of the kill would.
	readyOnClose bool
	// blockWrites makes WriteString block until Close, as a pty whose
	// reader stopped reading would.
	blockWrites bool
	writing     chan struct{}
	// failWith makes WriteString and Resize fail with it.
	failWith error

	readyOnce, stopOnce, writingOnce sync.Once

	endMu  sync.RWMutex
	ended  bool
	result pty.Result

	mu        sync.Mutex
	writes    []string
	resizes   []protocol.TerminalSize
	detaching bool
	// events lists MarkDetaching and Close in call order.
	events []string
}

func newFakeBridge(session string, queue int) *fakeBridge {
	return &fakeBridge{
		session: session,
		out:     make(chan string, queue),
		ready:   make(chan struct{}),
		done:    make(chan struct{}),
		stop:    make(chan struct{}),
		writing: make(chan struct{}),
	}
}

func (b *fakeBridge) Session() string        { return b.session }
func (b *fakeBridge) Output() <-chan string  { return b.out }
func (b *fakeBridge) Ready() <-chan struct{} { return b.ready }
func (b *fakeBridge) Done() <-chan struct{}  { return b.done }

func (b *fakeBridge) Wait() pty.Result {
	<-b.done
	b.endMu.RLock()
	defer b.endMu.RUnlock()
	return b.result
}

func (b *fakeBridge) WriteString(s string) (int, error) {
	if b.failWith != nil {
		return 0, b.failWith
	}
	if b.blockWrites {
		b.writingOnce.Do(func() { close(b.writing) })
		<-b.stop
		return 0, os.ErrClosed
	}
	select {
	case <-b.stop:
		return 0, os.ErrClosed
	default:
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.writes = append(b.writes, s)
	return len(s), nil
}

func (b *fakeBridge) Resize(cols, rows int) error {
	if b.failWith != nil {
		return b.failWith
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.resizes = append(b.resizes, protocol.TerminalSize{Cols: cols, Rows: rows})
	return nil
}

func (b *fakeBridge) MarkDetaching() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.detaching = true
	b.events = append(b.events, "MarkDetaching")
}

func (b *fakeBridge) Close() error {
	b.mu.Lock()
	b.detaching = true
	b.events = append(b.events, "Close")
	b.mu.Unlock()
	if b.readyOnClose {
		b.fireReady()
	}
	if b.stuck {
		return nil
	}
	b.stopOnce.Do(func() { close(b.stop) })
	b.end(pty.Result{Detached: true})
	return nil
}

func (b *fakeBridge) fireReady() { b.readyOnce.Do(func() { close(b.ready) }) }

// emit queues one chunk, ready first, as the real reader does. It blocks
// while the queue is full and reports false once the bridge is closed.
func (b *fakeBridge) emit(s string) bool {
	b.endMu.RLock()
	defer b.endMu.RUnlock()
	if b.ended {
		return false
	}
	b.fireReady()
	select {
	case b.out <- s:
		return true
	case <-b.stop:
		return false
	}
}

// end closes the output and publishes res, as the real bridge does once
// the process is reaped.
func (b *fakeBridge) end(res pty.Result) {
	b.endMu.Lock()
	defer b.endMu.Unlock()
	if b.ended {
		return
	}
	b.ended = true
	b.result = res
	close(b.out)
	close(b.done)
}

func (b *fakeBridge) snapshot() (writes []string, resizes []protocol.TerminalSize, events []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.Clone(b.writes), slices.Clone(b.resizes), slices.Clone(b.events)
}

// fakeSink records what it is sent. A gate can hold sends back. It checks
// every message with server.Encode, as the hub does, so a nil slice or a
// broken message fails the test.
type fakeSink struct {
	t *testing.T

	mu      sync.Mutex
	msgs    []server.Message
	changed chan struct{}
	gate    func(server.Message) <-chan struct{}
}

func newFakeSink(t *testing.T) *fakeSink {
	return &fakeSink{t: t, changed: make(chan struct{})}
}

func (s *fakeSink) Send(ctx context.Context, msg server.Message) error {
	if _, err := server.Encode(msg); err != nil {
		s.t.Errorf("sink got a message the hub would refuse: %v", err)
		return err
	}
	s.mu.Lock()
	gate := s.gate
	s.mu.Unlock()
	if gate != nil {
		if g := gate(msg); g != nil {
			select {
			case <-g:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	s.mu.Lock()
	s.msgs = append(s.msgs, msg)
	close(s.changed)
	s.changed = make(chan struct{})
	s.mu.Unlock()
	return nil
}

func (s *fakeSink) setGate(g func(server.Message) <-chan struct{}) {
	s.mu.Lock()
	s.gate = g
	s.mu.Unlock()
}

func (s *fakeSink) all() []server.Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.msgs)
}

func (s *fakeSink) types() []string {
	var out []string
	for _, m := range s.all() {
		out = append(out, m.WireType())
	}
	return out
}

func (s *fakeSink) reset() {
	s.mu.Lock()
	s.msgs = nil
	s.mu.Unlock()
}

func (s *fakeSink) last() server.Message {
	all := s.all()
	if len(all) == 0 {
		s.t.Fatal("sink is empty")
	}
	return all[len(all)-1]
}

// waitFor blocks until pred holds for the messages so far.
func (s *fakeSink) waitFor(pred func([]server.Message) bool) []server.Message {
	s.t.Helper()
	deadline := time.After(waitTimeout)
	for {
		s.mu.Lock()
		msgs := slices.Clone(s.msgs)
		changed := s.changed
		s.mu.Unlock()
		if pred(msgs) {
			return msgs
		}
		select {
		case <-changed:
		case <-deadline:
			s.t.Fatalf("timed out waiting, sink has %v", typesOf(msgs))
			return nil
		}
	}
}

func (s *fakeSink) waitCount(n int) []server.Message {
	s.t.Helper()
	return s.waitFor(func(m []server.Message) bool { return len(m) >= n })
}

func typesOf(msgs []server.Message) []string {
	out := make([]string, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, m.WireType())
	}
	return out
}

// waitUntil polls cond until it holds or the deadline passes.
func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitTimeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// fakeMonitor keeps the hooks it was built with.
type fakeMonitor struct {
	mu       sync.Mutex
	hooks    MonitorHooks
	started  int
	stopped  int
	startErr error
	ctx      context.Context
}

func (m *fakeMonitor) Start(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.started++
	m.ctx = ctx
	return m.startErr
}

func (m *fakeMonitor) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopped++
}

type attachCall struct {
	session string
	opts    pty.Options
}

// harness is a node over fakes.
type harness struct {
	t   *testing.T
	n   *Node
	tm  *fakeTmux
	mon *fakeMonitor

	mu       sync.Mutex
	queue    []*fakeBridge
	spawnErr error
	attaches []attachCall
	bridges  []*fakeBridge
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	return newHarnessWith(t, nil)
}

// newHarnessWith is newHarness with a hook that may add to the deps, such
// as the file service.
func newHarnessWith(t *testing.T, more func(*Deps)) *harness {
	t.Helper()
	h := &harness{t: t, tm: newFakeTmux(), mon: &fakeMonitor{}}
	deps := Deps{
		Tmux:   h.tm,
		Attach: h.attach,
		NewMonitor: func(hooks MonitorHooks) Monitor {
			h.mon.mu.Lock()
			h.mon.hooks = hooks
			h.mon.mu.Unlock()
			return h.mon
		},
		Logger: quiet,
	}
	if more != nil {
		more(&deps)
	}
	h.n = NewWithDeps(config.Config{TmuxSocket: "/run/test/tmux.sock"}, deps)
	t.Cleanup(func() {
		for _, id := range h.ids() {
			h.n.Close(id)
		}
		h.n.Stop()
	})
	return h
}

func (h *harness) ids() []node.ConnID {
	h.n.mu.Lock()
	defer h.n.mu.Unlock()
	var ids []node.ConnID
	for id := range h.n.conns {
		ids = append(ids, id)
	}
	return ids
}

func (h *harness) attach(_ context.Context, s string, opts pty.Options) (Bridge, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.attaches = append(h.attaches, attachCall{s, opts})
	if h.spawnErr != nil {
		return nil, h.spawnErr
	}
	var b *fakeBridge
	if len(h.queue) > 0 {
		b, h.queue = h.queue[0], h.queue[1:]
	} else {
		b = newFakeBridge(s, 8)
	}
	h.bridges = append(h.bridges, b)
	return b, nil
}

// next makes b the bridge of the next attach.
func (h *harness) next(b *fakeBridge) *fakeBridge {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.queue = append(h.queue, b)
	return b
}

func (h *harness) failSpawn(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.spawnErr = err
}

func (h *harness) lastBridge() *fakeBridge {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.bridges) == 0 {
		h.t.Fatal("no bridge was attached")
	}
	return h.bridges[len(h.bridges)-1]
}

func (h *harness) open(id node.ConnID) *fakeSink {
	h.t.Helper()
	s := newFakeSink(h.t)
	if err := h.n.Open(context.Background(), id, s); err != nil {
		h.t.Fatalf("Open %d: %v", id, err)
	}
	return s
}

func (h *harness) handle(id node.ConnID, msg client.Message) error {
	return h.n.Handle(context.Background(), id, msg)
}

// must runs msg and fails on an error return.
func (h *harness) must(id node.ConnID, msg client.Message) {
	h.t.Helper()
	if err := h.handle(id, msg); err != nil {
		h.t.Fatalf("Handle %s: %v", msg.WireType(), err)
	}
}

func (h *harness) conn(id node.ConnID) *conn {
	h.t.Helper()
	h.n.mu.Lock()
	defer h.n.mu.Unlock()
	c, ok := h.n.conns[id]
	if !ok {
		h.t.Fatalf("connection %d is not open", id)
	}
	return c
}

// setAttached sets the attached session without a pty, as the relay
// tests set conn.attachedSession.
func (h *harness) setAttached(id node.ConnID, name string) {
	c := h.conn(id)
	c.mu.Lock()
	c.attached = name
	c.mu.Unlock()
}

type connState struct {
	attached string
	bridge   Bridge
	lastSize *protocol.TerminalSize
	active   string
	pumping  bool
}

func (h *harness) state(id node.ConnID) connState {
	c := h.conn(id)
	c.mu.Lock()
	defer c.mu.Unlock()
	s := connState{attached: c.attached, lastSize: c.lastSize, active: c.activeWindowID}
	if c.att != nil {
		s.bridge = c.att.bridge
	}
	if c.last != nil {
		select {
		case <-c.last.done:
		default:
			s.pumping = true
		}
	}
	return s
}

// attachReady attaches id to name, fires ready and waits for the ack.
func (h *harness) attachReady(id node.ConnID, sink *fakeSink, name string, size *protocol.TerminalSize) *fakeBridge {
	h.t.Helper()
	before := len(sink.all())
	h.must(id, &client.SessionAttach{Type: "session:attach", Name: name, Size: size, Capture: ptr(false)})
	b := h.lastBridge()
	b.fireReady()
	sink.waitFor(func(m []server.Message) bool {
		for _, msg := range m[min(before, len(m)):] {
			if a, ok := msg.(*server.SessionAttached); ok && a.Name == name {
				return true
			}
		}
		return false
	})
	return b
}

func wantError(t *testing.T, msg server.Message, code, text string) {
	t.Helper()
	e, ok := msg.(*server.Error)
	if !ok {
		t.Fatalf("got %s, want error %s", msg.WireType(), code)
	}
	if e.Code != code || (text != "" && e.Message != text) {
		t.Fatalf("got error %s %q, want %s %q", e.Code, e.Message, code, text)
	}
}

var errBoom = errors.New("boom")
