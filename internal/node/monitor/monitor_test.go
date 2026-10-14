package monitor

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"tmuxde/internal/protocol"
)

func TestSessionPoll(t *testing.T) {
	// One step is one session poll: what tmux lists, then the callbacks
	// that poll should fire. The first step is the poll Start runs.
	type step struct {
		sessions []protocol.SessionInfo
		err      error
		want     []string
	}
	alpha, beta := session("alpha", "$1"), session("beta", "$2")
	tests := []struct {
		name  string
		steps []step
	}{
		{
			name: "first poll announces existing sessions",
			steps: []step{
				{sessions: []protocol.SessionInfo{alpha, beta}, want: []string{"created:alpha($1)", "created:beta($2)"}},
			},
		},
		{
			name: "unchanged sessions stay quiet",
			steps: []step{
				{sessions: []protocol.SessionInfo{alpha}, want: []string{"created:alpha($1)"}},
				{sessions: []protocol.SessionInfo{alpha}},
				{sessions: []protocol.SessionInfo{alpha}},
			},
		},
		{
			name: "vanished session fires exit",
			steps: []step{
				{sessions: []protocol.SessionInfo{alpha, beta}, want: []string{"created:alpha($1)", "created:beta($2)"}},
				{sessions: []protocol.SessionInfo{alpha}, want: []string{"exit:beta", "list:alpha/1"}},
			},
		},
		{
			name: "new session fires created",
			steps: []step{
				{sessions: []protocol.SessionInfo{alpha}, want: []string{"created:alpha($1)"}},
				{sessions: []protocol.SessionInfo{alpha, beta}, want: []string{"created:beta($2)", "list:alpha/1,beta/1"}},
			},
		},
		{
			// The same id under a new name is a rename, made anywhere. It
			// used to read as an exit and a create, and every browser was
			// told the session had exited.
			name: "rename keeps the id and fires renamed",
			steps: []step{
				{sessions: []protocol.SessionInfo{alpha}, want: []string{"created:alpha($1)"}},
				{sessions: []protocol.SessionInfo{session("gamma", "$1")}, want: []string{"renamed:alpha>gamma", "list:gamma/1"}},
				{sessions: []protocol.SessionInfo{session("gamma", "$1")}},
			},
		},
		{
			name: "a new id under a new name is an exit and a create",
			steps: []step{
				{sessions: []protocol.SessionInfo{alpha}, want: []string{"created:alpha($1)"}},
				{sessions: []protocol.SessionInfo{session("gamma", "$7")}, want: []string{"exit:alpha", "created:gamma($7)", "list:gamma/1"}},
			},
		},
		{
			name: "rename and create in one poll",
			steps: []step{
				{sessions: []protocol.SessionInfo{alpha, beta}, want: []string{"created:alpha($1)", "created:beta($2)"}},
				{
					sessions: []protocol.SessionInfo{beta, session("delta", "$9"), session("gamma", "$1")},
					want:     []string{"renamed:alpha>gamma", "created:delta($9)", "list:beta/1,delta/1,gamma/1"},
				},
			},
		},
		{
			// The session list shows the window count. A window opened
			// anywhere changes nothing else the poll saw.
			name: "window count change fires the list",
			steps: []step{
				{sessions: []protocol.SessionInfo{alpha, beta}, want: []string{"created:alpha($1)", "created:beta($2)"}},
				{sessions: []protocol.SessionInfo{withWindows(alpha, 2), beta}, want: []string{"list:alpha/2,beta/1"}},
				{sessions: []protocol.SessionInfo{withWindows(alpha, 2), beta}},
			},
		},
		{
			name: "attached flag change fires the list",
			steps: []step{
				{sessions: []protocol.SessionInfo{alpha}, want: []string{"created:alpha($1)"}},
				{sessions: []protocol.SessionInfo{attached(alpha)}, want: []string{"list:alpha/1"}},
			},
		},
		{
			// Activity moves with every burst of output. A list per burst
			// would be noise.
			name: "activity alone stays quiet",
			steps: []step{
				{sessions: []protocol.SessionInfo{alpha}, want: []string{"created:alpha($1)"}},
				{sessions: []protocol.SessionInfo{withActivity(alpha, "2026-10-12T00:05:00.000Z")}},
			},
		},
		{
			name: "no server fires exit for every known session",
			steps: []step{
				{sessions: []protocol.SessionInfo{beta, alpha}, want: []string{"created:beta($2)", "created:alpha($1)"}},
				{sessions: []protocol.SessionInfo{}, want: []string{"exit:alpha", "exit:beta", "list:"}},
				{sessions: []protocol.SessionInfo{alpha}, want: []string{"created:alpha($1)", "list:alpha/1"}},
			},
		},
		{
			name: "failed listing keeps known sessions",
			steps: []step{
				{sessions: []protocol.SessionInfo{alpha}, want: []string{"created:alpha($1)"}},
				{err: errors.New("tmux timed out")},
				{sessions: []protocol.SessionInfo{alpha}},
			},
		},
		{
			name: "failed first listing announces later",
			steps: []step{
				{err: errors.New("tmux timed out")},
				{sessions: []protocol.SessionInfo{alpha}, want: []string{"created:alpha($1)"}},
				{sessions: []protocol.SessionInfo{alpha}},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			src := &fakeSource{}
			h := newHarness(t, src, Options{})
			for i, st := range tt.steps {
				src.setSessions(st.sessions, st.err)
				before := len(h.rec.got())
				if i == 0 {
					h.start()
				} else {
					h.advance(DefaultSessionPoll)
				}
				if got := h.rec.got()[before:]; !slices.Equal(got, st.want) {
					t.Fatalf("poll %d fired %q, want %q", i, got, st.want)
				}
			}
			if got := src.count("sessions"); got != len(tt.steps) {
				t.Errorf("ListSessions ran %d times, want %d", got, len(tt.steps))
			}
		})
	}
}

func TestSessionPollLogsFailure(t *testing.T) {
	src := &fakeSource{}
	src.setSessions(nil, errors.New("tmux timed out"))
	h := newHarness(t, src, Options{})
	h.start()
	if logs := h.logs.String(); !strings.Contains(logs, "session monitor poll failed") || !strings.Contains(logs, "tmux timed out") {
		t.Errorf("logs miss the failure:\n%s", logs)
	}
}

func TestSessionPollRunsOnItsInterval(t *testing.T) {
	src := &fakeSource{}
	h := newHarness(t, src, Options{SessionPoll: 3 * time.Second, WindowPoll: 2 * time.Second})
	h.start()
	h.advance(2 * time.Second)
	if got := src.count("sessions"); got != 1 {
		t.Fatalf("ListSessions ran %d times after 2s, want 1", got)
	}
	h.advance(time.Second)
	if got := src.count("sessions"); got != 2 {
		t.Fatalf("ListSessions ran %d times after 3s, want 2", got)
	}
}

func TestCallbackPanicIsRecovered(t *testing.T) {
	src := layoutSource()
	src.setSessions([]protocol.SessionInfo{session("alpha", "$1"), session("beta", "$2")}, nil)
	h := newHarness(t, src, Options{Watched: watch("work")})
	h.m.OnSessionCreated(func(s protocol.SessionInfo) {
		if s.Name == "alpha" {
			panic("created callback broke")
		}
		h.rec.created(s)
	})
	var windowCalls atomic.Int32
	h.m.OnWindowsChanged(func(name string, windows []protocol.WindowInfo) {
		if windowCalls.Add(1) == 1 {
			panic("windows callback broke")
		}
		h.rec.windowsChanged(name, windows)
	})
	h.start()

	// beta still announced, alpha still counted as known.
	h.advance(DefaultSessionPoll)
	if got, want := h.rec.got(), []string{"created:beta($2)"}; !slices.Equal(got, want) {
		t.Fatalf("events %q, want %q", got, want)
	}

	src.setPanes(pane("%1", false, "/repo"), pane("%2", true, "/other"))
	h.advance(time.Second)
	src.setPanes(pane("%1", true, "/repo"), pane("%2", false, "/other"))
	h.advance(time.Second)
	if got, want := h.rec.got(), []string{"created:beta($2)", "windows:work"}; !slices.Equal(got, want) {
		t.Fatalf("events %q, want %q", got, want)
	}

	logs := h.logs.String()
	for _, want := range []string{"recovered panic", "OnSessionCreated", "created callback broke", "OnWindowsChanged", "windows callback broke"} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs miss %q:\n%s", want, logs)
		}
	}
}

func TestSourcePanicIsRecovered(t *testing.T) {
	src := layoutSource()
	var panicked atomic.Bool
	src.setHold(func(_ context.Context, method string) {
		if !panicked.Load() && (method == "ListSessions" || method == "ListPanes") {
			panic("source broke in " + method)
		}
	})
	h := newHarness(t, src, Options{Watched: watch("work")})
	h.start()
	panicked.Store(true)
	src.setSessions([]protocol.SessionInfo{session("alpha", "$1")}, nil)
	h.advance(DefaultSessionPoll)
	if got, want := h.rec.got(), []string{"created:alpha($1)"}; !slices.Equal(got, want) {
		t.Fatalf("events %q, want %q", got, want)
	}
	logs := h.logs.String()
	for _, want := range []string{"source broke in ListSessions", "source broke in ListPanes"} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs miss %q:\n%s", want, logs)
		}
	}
}

func TestSettersReplaceCallbacks(t *testing.T) {
	src := &fakeSource{}
	src.setSessions([]protocol.SessionInfo{session("alpha", "$1")}, nil)
	var fromOptions atomic.Int32
	h := newHarness(t, src, Options{
		OnSessionExit:     func(string) { fromOptions.Add(1) },
		OnSessionCreated:  func(protocol.SessionInfo) { fromOptions.Add(1) },
		OnSessionRenamed:  func(string, string) { fromOptions.Add(1) },
		OnSessionsChanged: func([]protocol.SessionInfo) { fromOptions.Add(1) },
	})
	h.m.OnSessionCreated(h.rec.created)
	h.m.OnSessionExit(h.rec.exit)
	h.m.OnSessionRenamed(h.rec.renamed)
	h.m.OnSessionsChanged(h.rec.listChanged)
	h.start()
	src.setSessions([]protocol.SessionInfo{session("gamma", "$1")}, nil)
	h.advance(DefaultSessionPoll)
	src.setSessions(nil, nil)
	h.advance(DefaultSessionPoll)
	want := []string{"created:alpha($1)", "renamed:alpha>gamma", "list:gamma/1", "exit:gamma", "list:"}
	if got := h.rec.got(); !slices.Equal(got, want) {
		t.Errorf("events %q, want %q", got, want)
	}
	if n := fromOptions.Load(); n != 0 {
		t.Errorf("replaced callbacks ran %d times", n)
	}

	// Nil removes a callback.
	h.m.OnSessionCreated(nil)
	h.m.OnSessionsChanged(nil)
	src.setSessions([]protocol.SessionInfo{session("beta", "$2")}, nil)
	h.advance(DefaultSessionPoll)
	if got := len(h.rec.got()); got != len(want) {
		t.Errorf("removed callback still ran, events %q", h.rec.got())
	}
}

func TestStopWaits(t *testing.T) {
	src := &fakeSource{}
	entered, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var finished atomic.Bool
	src.setHold(func(ctx context.Context, method string) {
		if method != "ListSessions" {
			return
		}
		close(entered)
		<-ctx.Done()
		close(canceled)
		// A slow tmux that ignores the context for a while.
		<-release
		finished.Store(true)
	})
	src.setSessions([]protocol.SessionInfo{session("alpha", "$1")}, nil)
	h := newHarness(t, src, Options{})
	if err := h.m.Start(t.Context()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	wait(t, entered, "session poll start")

	stopped := make(chan struct{})
	go func() {
		h.m.Stop()
		close(stopped)
	}()
	wait(t, canceled, "context cancel")
	select {
	case <-stopped:
		t.Fatal("Stop returned while a poll still ran")
	default:
	}
	close(release)
	wait(t, stopped, "Stop")
	if !finished.Load() {
		t.Error("Stop returned before the poll finished")
	}
	if got := h.rec.got(); len(got) != 0 {
		t.Errorf("poll cut short by Stop fired %q", got)
	}
	for _, d := range []time.Duration{DefaultSessionPoll, DefaultWindowPoll} {
		if !h.clock.ticker(t, d).isStopped() {
			t.Errorf("ticker %v not stopped", d)
		}
	}
	if logs := h.logs.String(); strings.Contains(logs, "poll failed") {
		t.Errorf("Stop logged a failure:\n%s", logs)
	}
}

func TestStopEndsPollsAndIsIdempotent(t *testing.T) {
	src := &fakeSource{}
	h := newHarness(t, src, Options{})
	h.m.Stop() // before Start does nothing
	h.start()
	h.m.Stop()
	h.m.Stop()
	if got := strings.Count(h.logs.String(), "session monitor stopped"); got != 1 {
		t.Errorf("stopped logged %d times, want 1", got)
	}
	// Nothing reads the tickers any more, so a fired tick stays queued.
	tk := h.clock.ticker(t, DefaultWindowPoll)
	if !tk.fire() || tk.fire() {
		t.Error("window ticker still read after Stop")
	}
	if got := src.count("sessions"); got != 1 {
		t.Errorf("ListSessions ran %d times, want 1", got)
	}
}

func TestStartTwice(t *testing.T) {
	h := newHarness(t, &fakeSource{}, Options{})
	h.start()
	if err := h.m.Start(t.Context()); !errors.Is(err, ErrStarted) {
		t.Errorf("second Start: %v, want ErrStarted", err)
	}
	h.m.Stop()
	if err := h.m.Start(t.Context()); !errors.Is(err, ErrStarted) {
		t.Errorf("Start after Stop: %v, want ErrStarted", err)
	}
}

func TestParentContextEndsPolls(t *testing.T) {
	src := &fakeSource{}
	h := newHarness(t, src, Options{})
	ctx, cancel := context.WithCancel(t.Context())
	if err := h.m.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	h.waitPolls(sessionPoll, windowPoll)
	cancel()
	for _, d := range []time.Duration{DefaultSessionPoll, DefaultWindowPoll} {
		tk := h.clock.ticker(t, d)
		eventually(t, "ticker stop", tk.isStopped)
	}
	h.m.Stop()
}

func TestNewDefaults(t *testing.T) {
	clock := &fakeClock{}
	m := New(&fakeSource{}, Options{Clock: clock, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err := m.Start(t.Context()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	m.Stop()
	if got, want := clock.periods(), []time.Duration{time.Second, 5 * time.Second}; !slices.Equal(got, want) {
		t.Errorf("ticker periods %v, want %v", got, want)
	}

	m = New(&fakeSource{}, Options{})
	if m.log != slog.Default() || m.sessionPoll != DefaultSessionPoll || m.windowPoll != DefaultWindowPoll {
		t.Error("zero Options did not pick the defaults")
	}
	if _, ok := m.clock.(realClock); !ok {
		t.Errorf("default clock is %T, want realClock", m.clock)
	}
	if got := m.watched(); got != nil {
		t.Errorf("default Watched returned %q", got)
	}
}

func TestNewNilSourcePanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("New(nil) did not panic")
		}
	}()
	New(nil, Options{})
}

// TestRealClock runs the monitor on real tickers with short intervals.
func TestRealClock(t *testing.T) {
	src := layoutSource()
	src.setSessions([]protocol.SessionInfo{session("work", "$1")}, nil)
	created := make(chan string, 4)
	changed := make(chan string, 4)
	m := New(src, Options{
		SessionPoll:      5 * time.Millisecond,
		WindowPoll:       5 * time.Millisecond,
		Watched:          watch("work"),
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		OnSessionCreated: func(s protocol.SessionInfo) { created <- s.Name },
		OnWindowsChanged: func(name string, _ []protocol.WindowInfo) { changed <- name },
	})
	if err := m.Start(t.Context()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(m.Stop)
	if got := wait(t, created, "session created"); got != "work" {
		t.Errorf("created %q, want work", got)
	}
	// Polls run one after another. Once the second pane listing started,
	// the first poll has seeded its baseline with the old layout.
	eventually(t, "second pane listing", func() bool { return src.count("panes:") > 1 })
	src.setPanes(pane("%1", false, "/repo"), pane("%2", true, "/other"))
	if got := wait(t, changed, "windows changed"); got != "work" {
		t.Errorf("changed %q, want work", got)
	}
	eventually(t, "ten more polls", func() bool { return src.count("sessions") > 10 })
	select {
	case name := <-created:
		t.Errorf("session %q announced twice", name)
	default:
	}
}
