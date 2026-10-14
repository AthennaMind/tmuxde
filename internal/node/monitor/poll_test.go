package monitor

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"tmuxde/internal/protocol"
)

// TestSessionMonitorWindowPoll ports "session monitor window poll" from
// session-monitor.test.ts. The window list alone cannot see pane focus moved
// with tmux keys, or cd in a pane. The browser kept showing the folder of
// the old pane.
func TestSessionMonitorWindowPoll(t *testing.T) {
	tests := []struct {
		name    string
		change  func(*fakeSource)
		advance time.Duration
		want    []string
	}{
		{
			name:    "stays quiet while nothing moves",
			advance: 3 * time.Second,
		},
		{
			name: "announces focus moved to another pane within a second",
			change: func(s *fakeSource) {
				s.setPanes(pane("%1", false, "/repo"), pane("%2", true, "/other"))
			},
			advance: time.Second,
			want:    []string{"windows:work"},
		},
		{
			name: "announces a folder change in a pane",
			change: func(s *fakeSource) {
				s.setPanes(pane("%1", true, "/repo/src"), pane("%2", false, "/other"))
			},
			advance: time.Second,
			want:    []string{"windows:work"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			src := layoutSource()
			h := newHarness(t, src, Options{Watched: watch("work")})
			// First sighting seeds the baseline and announces nothing.
			h.start()
			if got := h.rec.got(); len(got) != 0 {
				t.Fatalf("first poll fired %q", got)
			}
			if tt.change != nil {
				tt.change(src)
			}
			h.advance(tt.advance)
			if got := h.rec.got(); !slices.Equal(got, tt.want) {
				t.Errorf("events %q, want %q", got, tt.want)
			}
			if got, want := src.count("windows:work"), 1+int(tt.advance/time.Second); got != want {
				t.Errorf("ListWindows ran %d times, want %d", got, want)
			}
		})
	}
}

func TestWindowPollAnnouncesFreshWindows(t *testing.T) {
	src := layoutSource()
	h := newHarness(t, src, Options{Watched: watch("work")})
	h.start()

	// prefix z in the user's own terminal. Layout stays the same.
	zoomed := window()
	zoomed.Zoomed = ptr(true)
	src.setWindows(zoomed)
	h.advance(time.Second)
	if got := h.rec.lastWindows(); !reflect.DeepEqual(got, []protocol.WindowInfo{zoomed}) {
		t.Errorf("callback got %+v, want the zoomed window", got)
	}

	// The same layout again is no news.
	h.advance(2 * time.Second)
	if got, want := h.rec.got(), []string{"windows:work"}; !slices.Equal(got, want) {
		t.Errorf("events %q, want %q", got, want)
	}
}

func TestWindowPollNeverPassesNilWindows(t *testing.T) {
	src := layoutSource()
	h := newHarness(t, src, Options{Watched: watch("work")})
	h.start()
	src.setWindows()
	h.advance(time.Second)
	if got := h.rec.lastWindows(); got == nil || len(got) != 0 {
		t.Errorf("callback got %#v, want an empty non nil list", got)
	}
}

func TestWindowPollListsWatchedSessionsInOrder(t *testing.T) {
	src := layoutSource()
	h := newHarness(t, src, Options{Watched: watch("work", "", "play", "work")})
	h.start()

	var windows, panes []string
	for _, c := range src.callLog() {
		switch {
		case strings.HasPrefix(c, "windows:"):
			windows = append(windows, c)
		case strings.HasPrefix(c, "panes:"):
			panes = append(panes, c)
		}
	}
	// One session after another, so the windows calls keep watch order.
	if want := []string{"windows:work", "windows:play"}; !slices.Equal(windows, want) {
		t.Errorf("windows calls %q, want %q", windows, want)
	}
	// Panes run beside the windows call, so only the set is fixed. The
	// listing is never scoped to a window.
	slices.Sort(panes)
	if want := []string{"panes:play:", "panes:work:"}; !slices.Equal(panes, want) {
		t.Errorf("panes calls %q, want %q", panes, want)
	}
}

func TestWindowPollErrorDeletesSignature(t *testing.T) {
	src := layoutSource()
	h := newHarness(t, src, Options{Watched: watch("work")})
	h.start()

	src.setLayoutErr(errors.New("can't find session: work"))
	h.advance(time.Second)
	// The layout moved while tmux failed. The next good listing seeds a new
	// baseline and stays quiet, like a fresh attach.
	src.setLayoutErr(nil)
	src.setPanes(pane("%1", false, "/repo"), pane("%2", true, "/other"))
	h.advance(time.Second)
	if got := h.rec.got(); len(got) != 0 {
		t.Fatalf("listing after an error fired %q", got)
	}
	src.setPanes(pane("%1", true, "/repo"), pane("%2", false, "/other"))
	h.advance(time.Second)
	if got, want := h.rec.got(), []string{"windows:work"}; !slices.Equal(got, want) {
		t.Errorf("events %q, want %q", got, want)
	}
}

func TestWindowPollDropsUnwatchedSignature(t *testing.T) {
	src := layoutSource()
	var watching atomic.Bool
	watching.Store(true)
	h := newHarness(t, src, Options{Watched: func() []string {
		if watching.Load() {
			return []string{"work"}
		}
		return nil
	}})
	h.start()

	watching.Store(false)
	h.advance(time.Second)
	if n := len(h.m.sigs); n != 0 {
		// The test goroutine reads sigs only between polls, after waitPolls.
		t.Fatalf("%d signatures kept for unwatched sessions", n)
	}
	calls := src.count("windows:")
	src.setPanes(pane("%1", true, "/elsewhere"), pane("%2", false, "/other"))
	h.advance(time.Second)
	if got := src.count("windows:"); got != calls {
		t.Errorf("unwatched session polled %d times", got-calls)
	}

	watching.Store(true)
	h.advance(time.Second)
	if got := h.rec.got(); len(got) != 0 {
		t.Errorf("watched again, first poll fired %q", got)
	}
}

// TestWindowPollSkipsTickWhilePollRuns covers the reentrancy guard. A slow
// tmux must not run two polls at once, and the tick that came in meanwhile
// is dropped instead of starting a poll right after.
func TestWindowPollSkipsTickWhilePollRuns(t *testing.T) {
	src := layoutSource()
	h := newHarness(t, src, Options{Watched: watch("work")})
	h.start()

	entered, release := make(chan struct{}), make(chan struct{})
	var held atomic.Bool
	src.setHold(func(_ context.Context, method string) {
		if method == "ListWindows" && held.CompareAndSwap(false, true) {
			close(entered)
			<-release
		}
	})
	tk := h.clock.ticker(t, DefaultWindowPoll)
	if !tk.fire() {
		t.Fatal("first tick dropped")
	}
	wait(t, entered, "slow poll start")
	// The poll is stuck in tmux. A real ticker keeps one tick meanwhile.
	if !tk.fire() {
		t.Fatal("tick during the slow poll dropped")
	}
	close(release)
	h.waitPolls(windowPoll)
	// The tick from the slow poll is gone, so this one queues and polls.
	if !tk.fire() {
		t.Fatal("tick after the slow poll found one still queued")
	}
	h.waitPolls(windowPoll)
	h.m.Stop()

	if got := src.count("windows:"); got != 3 {
		t.Errorf("ListWindows ran %d times, want 3: seed, slow poll, last tick", got)
	}
	if got := src.maxInFlight(); got != 1 {
		t.Errorf("%d window polls ran at once, want 1", got)
	}
}

func TestSignatureFormat(t *testing.T) {
	windows := []protocol.WindowInfo{window(), {
		ID: "@4", Index: 1, Name: "logs", PaneCount: 1, Layout: "b25d,80x24,0,0,3", Zoomed: ptr(true),
	}}
	// %3 has no path, which reads as empty.
	panes := []protocol.PaneInfo{pane("%1", true, "/repo"), pane("%2", false, "/other"), {ID: "%3", WindowID: "@4", Active: true}}
	want := "@1:0:shell:1:2:0:layout|@4:1:logs:0:1:1:b25d,80x24,0,0,3" +
		"#%1:@1:1:/repo|%2:@1:0:/other|%3:@4:1:"
	if got := signature(windows, panes); got != want {
		t.Errorf("signature\n got %q\nwant %q", got, want)
	}
	if got := signature(nil, nil); got != "#" {
		t.Errorf("empty signature %q, want #", got)
	}
}

func TestSignatureFields(t *testing.T) {
	tests := []struct {
		name    string
		window  func(*protocol.WindowInfo)
		pane    func(*protocol.PaneInfo)
		changed bool
	}{
		{name: "window id", window: func(w *protocol.WindowInfo) { w.ID = "@9" }, changed: true},
		{name: "window index", window: func(w *protocol.WindowInfo) { w.Index = 3 }, changed: true},
		{name: "window name", window: func(w *protocol.WindowInfo) { w.Name = "vim" }, changed: true},
		{name: "window active", window: func(w *protocol.WindowInfo) { w.Active = false }, changed: true},
		{name: "pane count", window: func(w *protocol.WindowInfo) { w.PaneCount = 3 }, changed: true},
		{name: "window zoomed", window: func(w *protocol.WindowInfo) { w.Zoomed = ptr(true) }, changed: true},
		{name: "window layout", window: func(w *protocol.WindowInfo) { w.Layout = "other" }, changed: true},
		{name: "window zoomed unknown reads as false", window: func(w *protocol.WindowInfo) { w.Zoomed = nil }},
		{name: "window activity flag", window: func(w *protocol.WindowInfo) { w.Activity = ptr(true) }},
		{name: "window dimensions", window: func(w *protocol.WindowInfo) { w.Dimensions = &protocol.TerminalSize{Cols: 100, Rows: 30} }},
		{name: "pane id", pane: func(p *protocol.PaneInfo) { p.ID = "%7" }, changed: true},
		{name: "pane window", pane: func(p *protocol.PaneInfo) { p.WindowID = "@2" }, changed: true},
		{name: "pane active", pane: func(p *protocol.PaneInfo) { p.Active = false }, changed: true},
		{name: "pane path", pane: func(p *protocol.PaneInfo) { p.Path = ptr("/repo/src") }, changed: true},
		{name: "pane command", pane: func(p *protocol.PaneInfo) { p.Command = ptr("vim") }},
		{name: "pane size", pane: func(p *protocol.PaneInfo) { p.Dimensions = protocol.TerminalSize{Cols: 40, Rows: 12} }},
		{name: "pane position", pane: func(p *protocol.PaneInfo) { p.Position = protocol.Position{X: 41, Y: 0} }},
		{name: "pane zoomed", pane: func(p *protocol.PaneInfo) { p.Zoomed = true }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := window()
			p := pane("%1", true, "/repo")
			before := signature([]protocol.WindowInfo{w}, []protocol.PaneInfo{p})
			if tt.window != nil {
				tt.window(&w)
			}
			if tt.pane != nil {
				tt.pane(&p)
			}
			after := signature([]protocol.WindowInfo{w}, []protocol.PaneInfo{p})
			if changed := before != after; changed != tt.changed {
				t.Errorf("changed = %v, want %v (%q to %q)", changed, tt.changed, before, after)
			}
		})
	}
}
