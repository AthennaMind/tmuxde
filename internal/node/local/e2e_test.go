package local

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"tmuxde/internal/config"
	"tmuxde/internal/node/monitor"
	"tmuxde/internal/node/tmux"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// realServer is a tmux server on its own socket in a temp dir. Tests never
// talk to the default server. Cleanup kills it.
type realServer struct {
	t    *testing.T
	sock string
}

func newRealServer(t *testing.T) *realServer {
	t.Helper()
	if err := exec.Command("tmux", "-V").Run(); err != nil {
		t.Skipf("tmux -V failed: %v", err)
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &realServer{t: t, sock: filepath.Join(base, "sock")}
	t.Cleanup(func() {
		cmd := exec.Command("tmux", "-S", s.sock, "kill-server")
		cmd.Env = cleanEnv()
		_ = cmd.Run()
	})
	return s
}

// run is a tmux command from outside the node, as a user typing in
// their own terminal.
func (s *realServer) run(args ...string) {
	s.t.Helper()
	cmd := exec.Command("tmux", append([]string{"-f", "/dev/null", "-S", s.sock}, args...)...)
	cmd.Env = cleanEnv()
	if out, err := cmd.CombinedOutput(); err != nil {
		s.t.Fatalf("tmux %v: %v: %s", args, err, out)
	}
}

func (s *realServer) client() *tmux.Client {
	return tmux.New(tmux.Options{Socket: s.sock, DefaultShell: "/bin/sh", Logger: quiet})
}

// TestRealTmux runs the node over the real tmux client and the real pty
// bridge.
func TestRealTmux(t *testing.T) {
	srv := newRealServer(t)
	srv.run("new-session", "-d", "-s", "work", "-x", "80", "-y", "24", "/bin/sh")
	srv.run("new-session", "-d", "-s", "__tmuxde_clone", "/bin/sh")

	tc := srv.client()
	n := NewWithDeps(config.Config{TmuxSocket: srv.sock}, Deps{Tmux: tc, Logger: quiet})
	h := &harness{t: t, n: n}
	sink := h.open(1)
	t.Cleanup(func() { n.Close(1) })

	h.must(1, &client.SessionList{Type: "session:list"})
	var names []string
	for _, s := range sink.last().(*server.SessionList).Sessions {
		names = append(names, s.Name)
	}
	if !slices.Equal(names, []string{"work"}) {
		t.Fatalf("sessions = %v, want work only", names)
	}

	h.must(1, attachMsg("__tmuxde_clone", false))
	wantError(t, sink.last(), CodeSessionNotFound, `Session "__tmuxde_clone" not found`)
	// "wor" must not reach "work" by prefix.
	h.must(1, attachMsg("wor", false))
	wantError(t, sink.last(), CodeSessionNotFound, `Session "wor" not found`)
	sink.reset()

	msg := attachMsg("work", true)
	msg.Size = &protocol.TerminalSize{Cols: 100, Rows: 30}
	msg.AttachID = ptr("e1")
	h.must(1, msg)
	ack := sink.waitCount(1)[0].(*server.SessionAttached)
	if ack.Name != "work" || ack.AttachID == nil || *ack.AttachID != "e1" {
		t.Fatalf("first message = %+v, want the ack", ack)
	}

	h.must(1, &client.TerminalInput{Type: "terminal:input", Data: "echo tmuxde-$((40+2))\r"})
	sink.waitFor(func(m []server.Message) bool { return strings.Contains(outputOf(m), "tmuxde-42") })

	h.must(1, &client.PaneList{Type: "pane:list"})
	pl := lastOf[*server.PaneList](t, sink)
	if len(pl.Panes) != 1 || !strings.HasPrefix(pl.WindowID, "@") {
		t.Fatalf("pane:list = %+v", pl)
	}
	// The status line takes one row of the 100x30 attach.
	if d := pl.Panes[0].Dimensions; d.Cols != 100 || d.Rows != 29 {
		t.Fatalf("pane size = %+v, want 100x29 from the attach size", d)
	}
	h.must(1, &client.PaneCapture{Type: "pane:capture", ID: pl.Panes[0].ID})
	if got := lastOf[*server.PaneCaptured](t, sink); !strings.Contains(got.Content, "tmuxde-42") {
		t.Fatalf("capture = %q", got.Content)
	}
	h.must(1, &client.TmuxScrollState{Type: "tmux:scroll-state"})
	if got := lastOf[*server.TmuxScrollState](t, sink); got.InMode || got.PaneHeight != 29 {
		t.Fatalf("scroll state = %+v", got)
	}

	// The shell exits, the session ends, the attach client exits.
	h.must(1, &client.TerminalInput{Type: "terminal:input", Data: "exit\r"})
	msgs := sink.waitFor(func(m []server.Message) bool {
		return len(m) > 0 && m[len(m)-1].WireType() == "session:exited"
	})
	ex := msgs[len(msgs)-1].(*server.SessionExited)
	if ex.Name != "work" || ex.ExitCode == nil {
		t.Fatalf("exited = %+v, want work with a code", ex)
	}
	if st := h.state(1); st.attached != "" || st.bridge != nil {
		t.Fatalf("state = %+v, want cleared", st)
	}

	// The startup sweep kills the clone left by an earlier run.
	if err := n.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer n.Stop()
	if tc.SessionExists(context.Background(), "__tmuxde_clone") {
		t.Fatal("startup sweep left the clone")
	}
}

func cleanEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		switch k {
		case "TMUX", "TMUX_PANE", "AUTH_TOKEN":
			continue
		}
		env = append(env, kv)
	}
	return env
}

func outputOf(msgs []server.Message) string {
	var b strings.Builder
	for _, m := range msgs {
		if o, ok := m.(*server.TerminalOutput); ok {
			b.WriteString(o.Data)
		}
	}
	return b.String()
}

// lastOf returns the newest message of type T. Live output may arrive
// after a reply, so the last message is not always the reply.
func lastOf[T server.Message](t *testing.T, s *fakeSink) T {
	t.Helper()
	msgs := s.waitFor(func(m []server.Message) bool {
		for _, msg := range m {
			if _, ok := msg.(T); ok {
				return true
			}
		}
		return false
	})
	for i := len(msgs) - 1; i >= 0; i-- {
		if v, ok := msgs[i].(T); ok {
			return v
		}
	}
	var zero T
	return zero
}

// TestRealMonitor wires the real session monitor the way serve will and
// checks that changes made outside the browser reach the right
// connections.
func TestRealMonitor(t *testing.T) {
	srv := newRealServer(t)
	srv.run("new-session", "-d", "-s", "work", "-x", "80", "-y", "24", "/bin/sh")
	tc := srv.client()
	n := NewWithDeps(config.Config{TmuxSocket: srv.sock}, Deps{
		Tmux:   tc,
		Logger: quiet,
		NewMonitor: func(hk MonitorHooks) Monitor {
			return monitor.New(tc, monitor.Options{
				SessionPoll:      20 * time.Millisecond,
				WindowPoll:       20 * time.Millisecond,
				Watched:          hk.Watched,
				OnSessionExit:    hk.OnSessionExit,
				OnSessionCreated: hk.OnSessionCreated,
				OnWindowsChanged: hk.OnWindowsChanged,
				Logger:           quiet,
			})
		},
	})
	h := &harness{t: t, n: n}
	watcher, bystander := h.open(1), h.open(2)
	t.Cleanup(func() {
		n.Stop()
		n.Close(1)
		n.Close(2)
	})
	h.must(1, attachMsg("work", false))
	watcher.waitFor(hasType("session:attached"))
	if err := n.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	// The first window poll only seeds a baseline, and nothing says when
	// it ran. Rename until a change is announced.
	deadline := time.Now().Add(waitTimeout)
	for i := 0; !within(watcher, 100*time.Millisecond, hasType("window:changed")); i++ {
		if time.Now().After(deadline) {
			t.Fatal("no window:changed after renaming a window outside the browser")
		}
		srv.run("rename-window", "-t", "=work:", fmt.Sprintf("w%d", i))
	}
	msgs := watcher.waitFor(hasType("pane:changed"))
	if i, j := indexOf(msgs, "window:changed"), indexOf(msgs, "pane:changed"); i > j {
		t.Fatalf("got %v, want window:changed before pane:changed", typesOf(msgs))
	}
	if slices.Contains(bystander.types(), "window:changed") {
		t.Fatal("a connection not attached to work heard its window change")
	}

	// A clone first, then a real session. The clone is never announced,
	// and its turn comes before the real one, so checking after is enough.
	srv.run("new-session", "-d", "-s", "__tmuxde_x", "/bin/sh")
	srv.run("new-session", "-d", "-s", "late", "/bin/sh")
	for _, s := range []*fakeSink{watcher, bystander} {
		msgs := s.waitFor(func(m []server.Message) bool { return createdNamed(m, "late") })
		if createdNamed(msgs, "__tmuxde_x") {
			t.Fatal("a clone was announced")
		}
	}

	srv.run("kill-session", "-t", "=late")
	for _, s := range []*fakeSink{watcher, bystander} {
		msgs := s.waitFor(func(m []server.Message) bool {
			for _, msg := range m {
				if e, ok := msg.(*server.SessionExited); ok && e.Name == "late" {
					return true
				}
			}
			return false
		})
		for _, msg := range msgs {
			if e, ok := msg.(*server.SessionExited); ok && e.ExitCode != nil {
				t.Fatalf("monitor exit carries a code: %+v", e)
			}
		}
	}
}

// TestRealRenameAndListChanges renames the session a connection is
// attached to, once from the browser and once from a shell, and checks
// that the connection keeps working under the new name. The monitor
// reports a rename as a rename, never as an exit, and pushes the session
// list when a window count moves.
func TestRealRenameAndListChanges(t *testing.T) {
	srv := newRealServer(t)
	srv.run("new-session", "-d", "-s", "work", "-x", "80", "-y", "24", "/bin/sh")
	tc := srv.client()
	n := NewWithDeps(config.Config{TmuxSocket: srv.sock}, Deps{
		Tmux:   tc,
		Logger: quiet,
		NewMonitor: func(hk MonitorHooks) Monitor {
			return monitor.New(tc, monitor.Options{
				SessionPoll:       20 * time.Millisecond,
				WindowPoll:        20 * time.Millisecond,
				Watched:           hk.Watched,
				OnSessionExit:     hk.OnSessionExit,
				OnSessionCreated:  hk.OnSessionCreated,
				OnSessionRenamed:  hk.OnSessionRenamed,
				OnSessionsChanged: hk.OnSessionsChanged,
				OnWindowsChanged:  hk.OnWindowsChanged,
				Logger:            quiet,
			})
		},
	})
	h := &harness{t: t, n: n}
	watcher, bystander := h.open(1), h.open(2)
	t.Cleanup(func() {
		n.Stop()
		n.Close(1)
		n.Close(2)
	})
	h.must(1, attachMsg("work", false))
	watcher.waitFor(hasType("session:attached"))
	if err := n.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The first session poll announces what exists. Renames are compared
	// against what the monitor has seen, so it has to have seen work.
	bystander.waitFor(func(m []server.Message) bool { return createdNamed(m, "work") })

	// From the browser: the attached connection moves with the name at
	// once, so its next window message reaches the session.
	h.must(2, &client.SessionRename{Type: "session:rename", OldName: "work", NewName: "renamed"})
	if got := h.state(1).attached; got != "renamed" {
		t.Fatalf("attached = %q after the rename, want renamed", got)
	}
	watcher.reset()
	h.must(1, &client.WindowList{Type: "window:list"})
	if got := lastOf[*server.WindowList](t, watcher); got.SessionName != "renamed" || len(got.Windows) != 1 {
		t.Fatalf("window:list = %+v, want one window of renamed", got)
	}

	// The router sent one list. The monitor sends the second once it has
	// seen the new name.
	bystander.waitFor(func(m []server.Message) bool { return countLists(m, "renamed") >= 2 })

	// From a shell. The monitor sees the same id under a new name.
	bystander.reset()
	srv.run("rename-session", "-t", "=renamed", "outside")
	waitUntil(t, "the connection to follow a rename made outside", func() bool { return h.state(1).attached == "outside" })
	for _, s := range []*fakeSink{watcher, bystander} {
		s.waitFor(func(m []server.Message) bool { return listNamed(m, "outside", 1) })
	}

	// A window opened in a shell changes the count in the session list.
	srv.run("new-window", "-d", "-t", "=outside:", "/bin/sh")
	for _, s := range []*fakeSink{watcher, bystander} {
		s.waitFor(func(m []server.Message) bool { return listNamed(m, "outside", 2) })
	}

	// A rename is no exit. Every browser was told the session had exited.
	for _, s := range []*fakeSink{watcher, bystander} {
		for _, m := range s.all() {
			if e, ok := m.(*server.SessionExited); ok {
				t.Fatalf("got session:exited %q for a rename", e.Name)
			}
		}
	}

	// The pty exit names the session as it is called now.
	srv.run("kill-session", "-t", "=outside")
	msgs := watcher.waitFor(hasType("session:exited"))
	if e := msgs[indexOf(msgs, "session:exited")].(*server.SessionExited); e.Name != "outside" || e.ExitCode == nil {
		t.Fatalf("exit = %+v, want outside with a code", e)
	}
}

// countLists counts the session:list messages that hold name.
func countLists(msgs []server.Message, name string) int {
	n := 0
	for _, m := range msgs {
		if l, ok := m.(*server.SessionList); ok && slices.ContainsFunc(l.Sessions, func(s protocol.SessionInfo) bool { return s.Name == name }) {
			n++
		}
	}
	return n
}

// listNamed reports a session:list holding name with that many windows.
func listNamed(msgs []server.Message, name string, windows int) bool {
	for _, m := range msgs {
		l, ok := m.(*server.SessionList)
		if !ok {
			continue
		}
		for _, s := range l.Sessions {
			if s.Name == name && s.Windows == windows {
				return true
			}
		}
	}
	return false
}

func hasType(wireType string) func([]server.Message) bool {
	return func(m []server.Message) bool { return indexOf(m, wireType) >= 0 }
}

func indexOf(msgs []server.Message, wireType string) int {
	for i, m := range msgs {
		if m.WireType() == wireType {
			return i
		}
	}
	return -1
}

func createdNamed(msgs []server.Message, name string) bool {
	for _, m := range msgs {
		if c, ok := m.(*server.SessionCreated); ok && c.Session.Name == name {
			return true
		}
	}
	return false
}

// within reports whether pred holds for the sink before d has passed.
func within(s *fakeSink, d time.Duration, pred func([]server.Message) bool) bool {
	timeout := time.After(d)
	for {
		s.mu.Lock()
		msgs := slices.Clone(s.msgs)
		changed := s.changed
		s.mu.Unlock()
		if pred(msgs) {
			return true
		}
		select {
		case <-changed:
		case <-timeout:
			return false
		}
	}
}

// TestNewWiresRealTmux checks what New builds: the tmux client on the
// configured socket and default shell, the real pty, and the monitor
// watching the sessions a connection is attached to. Polls run at their
// production intervals.
func TestNewWiresRealTmux(t *testing.T) {
	srv := newRealServer(t)
	srv.run("new-session", "-d", "-s", "base", "/bin/sh")
	srv.run("new-session", "-d", "-s", "__tmuxde_old", "/bin/sh")

	// A default shell that prints a marker shows that new sessions run it.
	shell := filepath.Join(t.TempDir(), "shell")
	script := "#!/bin/sh\necho default-shell-$((6*7))\nexec cat\n"
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	n := New(config.Config{
		TmuxSocket:       srv.sock,
		TmuxDefaultShell: shell,
		Home:             home,
		AllowedPaths:     []string{home},
	}, quiet)
	h := &harness{t: t, n: n}
	sink := h.open(1)
	t.Cleanup(func() {
		n.Stop()
		n.Close(1)
	})
	if err := n.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	tc := srv.client()
	if tc.SessionExists(context.Background(), "__tmuxde_old") {
		t.Fatal("Start left the clone of an earlier run")
	}

	h.must(1, &client.SessionCreate{Type: "session:create", Name: ptr("made")})
	if got := lastOf[*server.SessionCreated](t, sink); got.Session.Name != "made" {
		t.Fatalf("created %+v", got.Session)
	}
	h.must(1, attachMsg("made", true))
	sink.waitFor(hasType("session:attached"))
	sink.waitFor(func(m []server.Message) bool { return strings.Contains(outputOf(m), "default-shell-42") })
	if got := n.watched(); !slices.Equal(got, []string{"made"}) {
		t.Fatalf("watched = %v, want [made]", got)
	}

	// The window poll runs every second. It seeds a baseline first, so
	// rename until a change is announced.
	deadline := time.Now().Add(waitTimeout)
	for i := 0; !within(sink, 300*time.Millisecond, hasType("window:changed")); i++ {
		if time.Now().After(deadline) {
			t.Fatal("no window:changed for the attached session")
		}
		srv.run("rename-window", "-t", "=made:", fmt.Sprintf("w%d", i))
	}
}

// TestStartWithoutTmux ports the relay's startup check. With no tmux in
// PATH the node refuses to start and says why.
func TestStartWithoutTmux(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	home := t.TempDir()
	n := New(config.Config{
		TmuxSocket:   filepath.Join(t.TempDir(), "sock"),
		Home:         home,
		AllowedPaths: []string{home},
	}, quiet)
	defer n.Stop()
	err := n.Start(context.Background())
	if !errors.Is(err, ErrNoTmux) {
		t.Fatalf("Start = %v, want ErrNoTmux", err)
	}
	if !strings.Contains(err.Error(), "tmux is not installed or not found in PATH") {
		t.Fatalf("error %q does not say what is missing", err)
	}
}
