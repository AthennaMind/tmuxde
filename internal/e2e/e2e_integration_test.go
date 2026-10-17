//go:build integration

package e2e

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/coder/websocket"

	"tmuxde/internal/node/local"
	"tmuxde/internal/protocol/server"
)

// TestIntegrationTerminal walks one browser session from create to kill, with a
// second browser that only listens.
func TestIntegrationTerminal(t *testing.T) {
	t.Parallel()
	// No monitor here, so every message checked comes from the router and
	// its broadcasts, not from a poll.
	s := newStack(t, false)
	a, b := s.dial("a"), s.dial("b")
	a.auth()
	b.auth()

	a.send(`{"type":"session:create","name":"e2e"}`)
	created := expect(a, waitLimit, "session:created e2e", func(m *server.SessionCreated) bool { return m.Session.Name == "e2e" })
	if c := created.Session; !strings.HasPrefix(c.ID, "$") || c.Windows != 1 || c.Attached {
		t.Fatalf("session:created = %+v", c)
	}
	expect(b, waitLimit, "session:created e2e on b", func(m *server.SessionCreated) bool { return m.Session.Name == "e2e" })

	// Ack first, then the capture replay and live output.
	a.skip()
	a.send(`{"type":"session:attach","name":"e2e","capture":true,"size":{"cols":100,"rows":30},"attachId":"a1"}`)
	ack := expect(a, waitLimit, "session:attached", func(m *server.SessionAttached) bool { return m.Name == "e2e" })
	if ack.AttachID == nil || *ack.AttachID != "a1" {
		t.Fatalf("session:attached = %+v, want attachId a1", ack)
	}
	all := a.all()
	if i := slices.IndexFunc(all, func(m server.Message) bool { return m.WireType() == "terminal:output" }); i >= 0 && i < slices.Index(all, server.Message(ack)) {
		t.Fatalf("output before the ack: %v", typesOf(all))
	}
	expect(a, waitLimit, "terminal:output after the ack", func(*server.TerminalOutput) bool { return true })
	s.tmux.waitTmux("session_attached of e2e", "1", func() string { return s.tmux.attachedClients("e2e") })

	// The typed command shows "e2e-marker-%s ok". Only the shell's output
	// joins the two halves.
	a.send(`{"type":"terminal:input","data":"printf e2e-marker-%s ok\r"}`)
	a.waitOutput("e2e-marker-ok")

	a.send(`{"type":"pane:list"}`)
	pl := expect(a, waitLimit, "pane:list", func(*server.PaneList) bool { return true })
	if len(pl.Panes) != 1 {
		t.Fatalf("pane:list = %+v, want one pane", pl)
	}
	p := pl.Panes[0]
	if !strings.HasPrefix(p.ID, "%") || !strings.HasPrefix(pl.WindowID, "@") || p.WindowID != pl.WindowID || !p.Active || p.Zoomed {
		t.Fatalf("pane:list = %+v", pl)
	}
	// The status line takes one row of the 100x30 attach.
	if p.Dimensions.Cols != 100 || p.Dimensions.Rows != 29 || p.Position.X != 0 || p.Position.Y != 0 {
		t.Fatalf("pane geometry = %+v at %+v, want 100x29 at 0,0", p.Dimensions, p.Position)
	}

	a.send(`{"type":"window:list"}`)
	wl := expect(a, waitLimit, "window:list", func(*server.WindowList) bool { return true })
	if wl.SessionName != "e2e" || len(wl.Windows) != 1 {
		t.Fatalf("window:list = %+v", wl)
	}
	w := wl.Windows[0]
	if w.ID != pl.WindowID || !w.Active || w.PaneCount != 1 || w.Layout == "" || w.Zoomed == nil || *w.Zoomed {
		t.Fatalf("window = %+v", w)
	}

	// A split publishes the window list, then the panes.
	a.send(`{"type":"pane:split","direction":"h"}`)
	wc := expect(a, waitLimit, "window:changed", func(*server.WindowChanged) bool { return true })
	if wc.SessionName != "e2e" || len(wc.Windows) != 1 || wc.Windows[0].PaneCount != 2 {
		t.Fatalf("window:changed = %+v", wc)
	}
	pc := expect(a, waitLimit, "pane:changed after window:changed", func(*server.PaneChanged) bool { return true })
	if pc.WindowID != pl.WindowID || len(pc.Panes) != 2 {
		t.Fatalf("pane:changed = %+v, want two panes in %s", pc, pl.WindowID)
	}
	if got := strings.Fields(s.tmux.must("list-panes", "-t", "=e2e:", "-F", "#{pane_id}")); len(got) != 2 {
		t.Fatalf("tmux list-panes = %v, want two panes", got)
	}

	a.send(`{"type":"terminal:resize","size":{"cols":120,"rows":40}}`)
	s.tmux.waitTmux("client size of e2e", "120x40", func() string {
		return strings.TrimSpace(s.tmux.must("list-clients", "-t", "=e2e", "-F", "#{client_width}x#{client_height}"))
	})

	a.send(`{"type":"tmux:scroll-state"}`)
	st := expect(a, waitLimit, "tmux:scroll-state", func(*server.TmuxScrollState) bool { return true })
	// Side by side after the split, so the active pane has the full
	// height: 40 rows less the status line.
	if st.InMode || st.Position != 0 || st.HistorySize < 0 || st.PaneHeight != 39 {
		t.Fatalf("tmux:scroll-state = %+v, want live view, pane height 39", st)
	}

	// The other browser hears about a second session.
	a.send(`{"type":"session:create","name":"e2e-two"}`)
	expect(a, waitLimit, "session:created e2e-two", func(m *server.SessionCreated) bool { return m.Session.Name == "e2e-two" })
	expect(b, waitLimit, "session:created e2e-two on b", func(m *server.SessionCreated) bool { return m.Session.Name == "e2e-two" })

	// Detach releases the tmux client, without a word to the browser.
	a.send(`{"type":"session:detach"}`)
	s.tmux.waitTmux("session_attached of e2e after detach", "0", func() string { return s.tmux.attachedClients("e2e") })

	a.send(`{"type":"session:kill","name":"e2e"}`)
	expect(a, waitLimit, "session:killed e2e", func(m *server.SessionKilled) bool { return m.Name == "e2e" })
	expect(b, waitLimit, "session:killed e2e on b", func(m *server.SessionKilled) bool { return m.Name == "e2e" })
	if _, err := s.tmux.output("has-session", "-t", "=e2e"); err == nil {
		t.Fatal("e2e still exists after session:kill")
	}
	if _, err := s.tmux.output("has-session", "-t", "=e2e-two"); err != nil {
		t.Fatalf("e2e-two went with e2e: %v", err)
	}
	// The detached pty ended in silence.
	for _, m := range a.all() {
		if e, ok := m.(*server.SessionExited); ok {
			t.Fatalf("a got %+v after it detached", e)
		}
	}
}

// TestIntegrationNewSessionFolder checks where new sessions and windows start when
// the browser names no folder: home, as on the relay, not the folder
// tmuxde was started from. The test process runs in the package folder,
// and the tmux server was started from there too, so a pane that started
// there would show it.
func TestIntegrationNewSessionFolder(t *testing.T) {
	t.Parallel()
	s := newStack(t, false)
	a := s.dial("a")
	a.auth()

	paths := func(target string) []string {
		return strings.Fields(s.tmux.must("list-panes", "-s", "-t", target, "-F", "#{pane_current_path}"))
	}

	a.send(`{"type":"session:create","name":"e2e-home"}`)
	expect(a, waitLimit, "session:created e2e-home", func(m *server.SessionCreated) bool { return m.Session.Name == "e2e-home" })
	if got := paths("=e2e-home"); !slices.Equal(got, []string{s.home}) {
		t.Fatalf("new session starts in %v, want home %s", got, s.home)
	}

	// A folder the browser names still wins.
	sub := filepath.Join(s.home, "work")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	a.send(`{"type":"session:create","name":"e2e-sub","cwd":"` + sub + `"}`)
	expect(a, waitLimit, "session:created e2e-sub", func(m *server.SessionCreated) bool { return m.Session.Name == "e2e-sub" })
	if got := paths("=e2e-sub"); !slices.Equal(got, []string{sub}) {
		t.Fatalf("session with cwd starts in %v, want %s", got, sub)
	}

	// A window made from the browser starts in home as well.
	a.send(`{"type":"session:attach","name":"e2e-home","size":{"cols":80,"rows":24}}`)
	expect(a, waitLimit, "session:attached", func(m *server.SessionAttached) bool { return m.Name == "e2e-home" })
	a.send(`{"type":"window:create","name":"second"}`)
	s.tmux.waitTmux("windows of e2e-home", "2", func() string {
		return strings.TrimSpace(s.tmux.must("display-message", "-p", "-t", "=e2e-home:", "#{session_windows}"))
	})
	if got := paths("=e2e-home"); !slices.Equal(got, []string{s.home, s.home}) {
		t.Fatalf("panes of e2e-home start in %v, want home %s twice", got, s.home)
	}
}

// TestIntegrationRefusals checks the exact error codes the browser acts on.
func TestIntegrationRefusals(t *testing.T) {
	t.Parallel()
	s := newStack(t, true)
	// Made after Start, so the sweep has passed. The node must hide it on
	// its own.
	s.tmux.must("new-session", "-d", "-s", "__tmuxde_hidden", "/bin/sh")
	a := s.dial("a")
	a.auth()

	tests := []struct {
		name  string
		frame string
		code  string
		text  string
	}{
		{"input before attach", `{"type":"terminal:input","data":"x"}`, local.CodeNotAttached, "No session attached"},
		{"resize before attach", `{"type":"terminal:resize","size":{"cols":80,"rows":24}}`, local.CodeNotAttached, "No session attached"},
		{"pane list before attach", `{"type":"pane:list"}`, local.CodeNotAttached, "No session attached"},
		{"scroll state before attach", `{"type":"tmux:scroll-state"}`, local.CodeNotAttached, "No session attached"},
		{"missing session", `{"type":"session:attach","name":"missing"}`, local.CodeSessionNotFound, `Session "missing" not found`},
		{"clone session", `{"type":"session:attach","name":"__tmuxde_hidden"}`, local.CodeSessionNotFound, `Session "__tmuxde_hidden" not found`},
		{"prefix of a session", `{"type":"session:attach","name":"bas"}`, local.CodeSessionNotFound, `Session "bas" not found`},
		{"input after a refused attach", `{"type":"terminal:input","data":"x"}`, local.CodeNotAttached, "No session attached"},
		{"pane id before attach", `{"type":"pane:capture","id":"%0"}`, local.CodeNotAttached, "No session attached"},
	}
	for _, tt := range tests {
		a.send(tt.frame)
		a.expectError(tt.code, tt.text)
	}

	// Attached, a pane or window of another session is still refused.
	// tmux resolves ids server wide, so only the node can say no.
	a.send(`{"type":"session:attach","name":"base"}`)
	expect(a, waitLimit, "session:attached base", func(m *server.SessionAttached) bool { return m.Name == "base" })
	hiddenPane := strings.TrimSpace(s.tmux.must("list-panes", "-t", "=__tmuxde_hidden:", "-F", "#{pane_id}"))
	hiddenWindow := strings.TrimSpace(s.tmux.must("list-windows", "-t", "=__tmuxde_hidden", "-F", "#{window_id}"))
	a.send(`{"type":"pane:capture","id":"` + hiddenPane + `"}`)
	a.expectError(local.CodePaneNotFound, `Pane "`+hiddenPane+`" not found`)
	a.send(`{"type":"window:select","id":"` + hiddenWindow + `"}`)
	a.expectError(local.CodeWindowNotFound, `Window "`+hiddenWindow+`" not found`)
	if got := strings.TrimSpace(s.tmux.must("display-message", "-p", "-t", "=base:", "#{window_id}")); got == hiddenWindow {
		t.Fatal("the refused window:select switched the window")
	}

	a.send(`{"type":"session:list"}`)
	list := expect(a, waitLimit, "session:list", func(*server.SessionList) bool { return true })
	var names []string
	for _, s := range list.Sessions {
		names = append(names, s.Name)
	}
	if !slices.Equal(names, []string{"base"}) {
		t.Fatalf("session:list = %v, want base only", names)
	}
	if got := s.tmux.attachedClients("__tmuxde_hidden"); got != "0" {
		t.Fatalf("clone has %s clients attached", got)
	}
	if got := s.tmux.attachedClients("base"); got != "1" {
		t.Fatalf("base has %s clients attached, want 1", got)
	}
	for _, m := range a.all() {
		if c, ok := m.(*server.SessionCreated); ok && strings.HasPrefix(c.Session.Name, "__tmuxde_") {
			t.Fatalf("clone announced: %+v", c)
		}
	}
}

// TestIntegrationMonitorExit kills a session from outside the browser. A browser
// attached to it learns from its own pty, with the exit code. One that is
// not attached learns from the session monitor.
func TestIntegrationMonitorExit(t *testing.T) {
	t.Parallel()
	// The monitor reports an exit only for a session it has seen. Its
	// first poll runs at Start, so victim must exist by then.
	s := newStack(t, true, "victim")
	a, b := s.dial("a"), s.dial("b")
	a.auth()
	b.auth()
	a.send(`{"type":"session:attach","name":"victim"}`)
	expect(a, waitLimit, "session:attached", func(m *server.SessionAttached) bool { return m.Name == "victim" })
	s.tmux.waitTmux("session_attached of victim", "1", func() string { return s.tmux.attachedClients("victim") })

	s.tmux.must("kill-session", "-t", "=victim")

	got := expect(a, waitLimit, "session:exited from the pty", func(m *server.SessionExited) bool { return m.Name == "victim" })
	if got.ExitCode == nil {
		t.Fatalf("attached browser got %+v, want an exit code", got)
	}
	got = expect(b, monitorLimit, "session:exited from the monitor", func(m *server.SessionExited) bool { return m.Name == "victim" })
	if got.ExitCode != nil {
		t.Fatalf("monitor sent %+v, want no exit code", got)
	}
	// The pty exit cleared the attach.
	a.send(`{"type":"terminal:input","data":"x"}`)
	a.expectError(local.CodeNotAttached, "No session attached")
}

// TestIntegrationCloseReleasesPty checks that a closed browser connection and a hub
// shutdown both release the tmux client, and leave the session running.
func TestIntegrationCloseReleasesPty(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		stop func(t *testing.T, s *stack, c *client)
		// code is the close code the browser must see. Zero skips the
		// check: the browser closed, so it sees its own close.
		code websocket.StatusCode
	}{
		{
			name: "browser closes",
			stop: func(t *testing.T, _ *stack, c *client) {
				if err := c.conn.Close(websocket.StatusNormalClosure, ""); err != nil {
					t.Logf("close handshake: %v", err)
				}
			},
		},
		{
			name: "hub shuts down",
			stop: func(t *testing.T, s *stack, _ *client) {
				ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
				defer cancel()
				if err := s.relay.Shutdown(ctx); err != nil {
					t.Errorf("shutdown: %v", err)
				}
			},
			code: websocket.StatusGoingAway,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			s := newStack(t, true, "held")
			c := s.dial("a")
			c.auth()
			c.send(`{"type":"session:attach","name":"held","capture":true,"size":{"cols":90,"rows":20}}`)
			expect(c, waitLimit, "session:attached", func(m *server.SessionAttached) bool { return m.Name == "held" })
			s.tmux.waitTmux("session_attached of held", "1", func() string { return s.tmux.attachedClients("held") })

			tt.stop(t, s, c)
			if got := closeCode(c.closed()); tt.code != 0 && got != tt.code {
				t.Fatalf("close code %d, want %d", got, tt.code)
			}
			s.tmux.waitTmux("session_attached of held after close", "0", func() string { return s.tmux.attachedClients("held") })
			s.tmux.waitTmux("open node connections", "0", func() string {
				if s.node.OpenCount() == 0 {
					return "0"
				}
				return "more"
			})
			if _, err := s.tmux.output("has-session", "-t", "=held"); err != nil {
				t.Fatalf("the session ended with the browser: %v", err)
			}
		})
	}
}
