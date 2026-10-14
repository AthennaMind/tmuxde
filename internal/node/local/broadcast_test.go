package local

import (
	"context"
	"slices"
	"testing"

	"tmuxde/internal/node"
	"tmuxde/internal/node/pty"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// room is four connections: 1 and 2 attached to work, 3 attached to
// other, 4 not attached.
type room struct {
	h     *harness
	sinks map[node.ConnID]*fakeSink
}

func newRoom(t *testing.T) *room {
	h := newHarness(t)
	r := &room{h: h, sinks: map[node.ConnID]*fakeSink{}}
	for id := node.ConnID(1); id <= 4; id++ {
		r.sinks[id] = h.open(id)
	}
	h.attachReady(1, r.sinks[1], "work", nil)
	h.attachReady(2, r.sinks[2], "work", nil)
	h.attachReady(3, r.sinks[3], "other", nil)
	for _, s := range r.sinks {
		s.reset()
	}
	return r
}

// got lists the message types each connection received.
func (r *room) got() map[node.ConnID][]string {
	out := map[node.ConnID][]string{}
	for id, s := range r.sinks {
		out[id] = s.types()
	}
	return out
}

func (r *room) want(t *testing.T, want map[node.ConnID][]string) {
	t.Helper()
	got := r.got()
	for id := node.ConnID(1); id <= 4; id++ {
		if !slices.Equal(got[id], want[id]) {
			t.Errorf("connection %d got %v, want %v", id, got[id], want[id])
		}
	}
}

// TestAnnounceLayout checks order and recipients: the sender first, then
// every other connection attached to the same session, each with
// window:changed before pane:changed.
func TestAnnounceLayout(t *testing.T) {
	r := newRoom(t)
	r.h.must(1, &client.PaneSplit{Type: "pane:split", Direction: "v"})

	pair := []string{"window:changed", "pane:changed"}
	r.want(t, map[node.ConnID][]string{1: pair, 2: pair})
	w := r.sinks[2].all()[0].(*server.WindowChanged)
	if w.SessionName != "work" {
		t.Fatalf("sessionName = %q", w.SessionName)
	}
}

func TestBroadcastCreated(t *testing.T) {
	r := newRoom(t)
	r.h.tm.set(func(f *fakeTmux) { f.created = session("fresh", "$5") })
	r.h.must(4, &client.SessionCreate{Type: "session:create", Name: ptr("fresh")})

	one := []string{"session:created"}
	r.want(t, map[node.ConnID][]string{1: one, 2: one, 3: one, 4: one})
	for id, s := range r.sinks {
		if got := s.last().(*server.SessionCreated).Session.Name; got != "fresh" {
			t.Errorf("connection %d heard of %q", id, got)
		}
	}
}

func TestBroadcastCreatedClone(t *testing.T) {
	r := newRoom(t)
	r.h.tm.set(func(f *fakeTmux) { f.created = session("__tmuxde_x", "$5") })
	r.h.must(4, &client.SessionCreate{Type: "session:create", Name: ptr("__tmuxde_x")})

	// The sender hears what it asked for. Nobody else ever hears of a
	// clone.
	r.want(t, map[node.ConnID][]string{4: {"session:created"}})
}

func TestBroadcastKilled(t *testing.T) {
	r := newRoom(t)
	r.h.must(3, &client.SessionKill{Type: "session:kill", Name: "spare"})

	one := []string{"session:killed"}
	r.want(t, map[node.ConnID][]string{1: one, 2: one, 3: one, 4: one})
	if got := r.h.tm.called("KillSession"); !slices.Equal(got, []string{"KillSession spare"}) {
		t.Fatalf("calls = %v", got)
	}

	for _, s := range r.sinks {
		s.reset()
	}
	r.h.must(3, &client.SessionKill{Type: "session:kill", Name: "__tmuxde_x"})
	r.want(t, map[node.ConnID][]string{3: one})
}

// TestBroadcastRename: the sender and every other connection get a fresh
// session list, clones left out.
func TestBroadcastRename(t *testing.T) {
	r := newRoom(t)
	r.h.tm.set(func(f *fakeTmux) {
		f.sessions = []protocol.SessionInfo{session("renamed", "$1"), session("other", "$2"), session("__tmuxde_c", "$3")}
	})
	r.h.must(1, &client.SessionRename{Type: "session:rename", OldName: "work", NewName: "renamed"})

	one := []string{"session:list"}
	r.want(t, map[node.ConnID][]string{1: one, 2: one, 3: one, 4: one})
	if got := r.h.tm.called("RenameSession"); !slices.Equal(got, []string{"RenameSession work renamed"}) {
		t.Fatalf("calls = %v", got)
	}
	for id, s := range r.sinks {
		var names []string
		for _, si := range s.last().(*server.SessionList).Sessions {
			names = append(names, si.Name)
		}
		if !slices.Equal(names, []string{"renamed", "other"}) {
			t.Errorf("connection %d got %v", id, names)
		}
	}
}

// TestRenameMovesAttachedConnections: a rename made in the browser moves
// every connection attached to the old name before the list goes out, so
// their window and pane messages keep reaching the session and the monitor
// watches the new name.
func TestRenameMovesAttachedConnections(t *testing.T) {
	r := newRoom(t)
	r.h.must(3, &client.SessionRename{Type: "session:rename", OldName: "work", NewName: "renamed"})

	for _, id := range []node.ConnID{1, 2} {
		if got := r.h.state(id).attached; got != "renamed" {
			t.Errorf("connection %d attached to %q, want renamed", id, got)
		}
	}
	if got := r.h.state(3).attached; got != "other" {
		t.Errorf("connection 3 attached to %q, want other", got)
	}
	if got := r.h.n.watched(); !slices.Equal(got, []string{"other", "renamed"}) {
		t.Fatalf("watched = %v, want [other renamed]", got)
	}

	for _, s := range r.sinks {
		s.reset()
	}
	r.h.must(1, &client.WindowList{Type: "window:list"})
	if got := r.sinks[1].last().(*server.WindowList).SessionName; got != "renamed" {
		t.Fatalf("window:list for %q, want renamed", got)
	}
}

// TestMonitorRename: a rename made outside the browser moves the attached
// connections the same way. The hook sends nothing. The list follows from
// OnSessionsChanged.
func TestMonitorRename(t *testing.T) {
	r := newRoom(t)
	r.h.n.followRename("work", "outside")

	for _, id := range []node.ConnID{1, 2} {
		if got := r.h.state(id).attached; got != "outside" {
			t.Errorf("connection %d attached to %q, want outside", id, got)
		}
	}
	if got := r.h.state(3).attached; got != "other" {
		t.Errorf("connection 3 attached to %q, want other", got)
	}
	if got := r.h.state(4).attached; got != "" {
		t.Errorf("connection 4 attached to %q, want nothing", got)
	}
	r.want(t, map[node.ConnID][]string{})
}

// TestExitAfterRename: the pty exit names the session as it is called
// now. The browser knows it by the new name after following the rename.
func TestExitAfterRename(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	b := h.attachReady(1, sink, "work", nil)
	h.n.followRename("work", "renamed")
	sink.reset()
	b.end(pty.Result{ExitCode: 0})

	msgs := sink.waitFor(hasType("session:exited"))
	if ex := msgs[indexOf(msgs, "session:exited")].(*server.SessionExited); ex.Name != "renamed" {
		t.Fatalf("exited %q, want renamed", ex.Name)
	}
	if got := h.state(1).attached; got != "" {
		t.Fatalf("still attached to %q after the exit", got)
	}
}

// TestMonitorSessionsChanged: a list change seen by the monitor goes to
// every connection, clones left out.
func TestMonitorSessionsChanged(t *testing.T) {
	r := newRoom(t)
	work := session("work", "$1")
	work.Windows = 2
	r.h.n.sessionsChanged([]protocol.SessionInfo{work, session("__tmuxde_c", "$3")})

	one := []string{"session:list"}
	r.want(t, map[node.ConnID][]string{1: one, 2: one, 3: one, 4: one})
	for id, s := range r.sinks {
		list := s.last().(*server.SessionList).Sessions
		if len(list) != 1 || list[0].Name != "work" || list[0].Windows != 2 {
			t.Errorf("connection %d got %+v", id, list)
		}
	}

	// Never null on the wire.
	for _, s := range r.sinks {
		s.reset()
	}
	r.h.n.sessionsChanged(nil)
	if got := r.sinks[4].last().(*server.SessionList).Sessions; got == nil || len(got) != 0 {
		t.Fatalf("empty list = %#v, want []", got)
	}
}

// TestMonitorExit: the monitor's exit goes to every connection not
// attached to the session, without an exit code. The attached ones learn
// from their own pty.
func TestMonitorExit(t *testing.T) {
	r := newRoom(t)
	r.h.n.sessionExited("work")

	one := []string{"session:exited"}
	r.want(t, map[node.ConnID][]string{3: one, 4: one})
	ex := r.sinks[3].last().(*server.SessionExited)
	if ex.Name != "work" || ex.ExitCode != nil {
		t.Fatalf("exited = %+v, want work without a code", ex)
	}

	for _, s := range r.sinks {
		s.reset()
	}
	r.h.n.sessionExited("__tmuxde_x")
	r.want(t, map[node.ConnID][]string{})
}

func TestMonitorCreated(t *testing.T) {
	r := newRoom(t)
	r.h.n.sessionCreated(session("fresh", "$5"))
	one := []string{"session:created"}
	r.want(t, map[node.ConnID][]string{1: one, 2: one, 3: one, 4: one})

	for _, s := range r.sinks {
		s.reset()
	}
	r.h.n.sessionCreated(session("__tmuxde_x", "$6"))
	r.want(t, map[node.ConnID][]string{})
}

// TestMonitorWindowsChanged: a change made outside the browser goes to the
// connections attached to the session, the window half and then the pane
// half. A failed pane listing drops only the pane half.
func TestMonitorWindowsChanged(t *testing.T) {
	r := newRoom(t)
	windows := []protocol.WindowInfo{window("@1", 0, true), window("@5", 1, false)}
	r.h.n.windowsChanged(context.Background(), "work", windows)

	pair := []string{"window:changed", "pane:changed"}
	r.want(t, map[node.ConnID][]string{1: pair, 2: pair})
	if w := r.sinks[1].all()[0].(*server.WindowChanged); len(w.Windows) != 2 || w.SessionName != "work" {
		t.Fatalf("window:changed = %+v", w)
	}

	for _, s := range r.sinks {
		s.reset()
	}
	r.h.tm.set(func(f *fakeTmux) { f.errs["CurrentWindowPanes"] = errBoom })
	r.h.n.windowsChanged(context.Background(), "other", nil)
	r.want(t, map[node.ConnID][]string{3: {"window:changed"}})

	for _, s := range r.sinks {
		s.reset()
	}
	r.h.n.windowsChanged(context.Background(), "__tmuxde_x", windows)
	r.h.n.windowsChanged(context.Background(), "nobody", windows)
	r.want(t, map[node.ConnID][]string{})
	if got := r.h.tm.called("CurrentWindowPanes nobody"); len(got) != 0 {
		t.Fatalf("listed panes of a session nobody watches: %v", got)
	}
}

// TestMonitorHooksThroughStart drives the hooks the way the real monitor
// does, through what Start handed it.
func TestMonitorHooksThroughStart(t *testing.T) {
	r := newRoom(t)
	if err := r.h.n.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.h.mon.mu.Lock()
	hooks := r.h.mon.hooks
	r.h.mon.mu.Unlock()

	hooks.OnWindowsChanged("work", []protocol.WindowInfo{window("@1", 0, true)})
	hooks.OnSessionExit("other")
	pair := []string{"window:changed", "pane:changed"}
	r.want(t, map[node.ConnID][]string{
		1: append(slices.Clone(pair), "session:exited"),
		2: append(slices.Clone(pair), "session:exited"),
		4: {"session:exited"},
	})
}

// TestStalledBrowserDoesNotHoldUpOthers: broadcast sends run in parallel,
// so one connection that stopped reading does not delay the rest. Closing
// the stalled connection ends its send.
func TestStalledBrowserDoesNotHoldUpOthers(t *testing.T) {
	r := newRoom(t)
	r.sinks[2].setGate(func(server.Message) <-chan struct{} { return make(chan struct{}) })

	done := make(chan struct{})
	go func() {
		defer close(done)
		r.h.n.sessionCreated(session("fresh", "$5"))
	}()
	for _, id := range []node.ConnID{1, 3, 4} {
		r.sinks[id].waitCount(1)
	}
	select {
	case <-done:
		t.Fatal("broadcast returned before the stalled send ended")
	default:
	}
	r.h.n.Close(2)
	<-done
}
