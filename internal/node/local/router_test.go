package local

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// Ported from message-router.test.ts, describe "scoped grants". Only the
// ownership cases survive. Every other grant gate collapsed into the one
// full grant.
func TestPaneOwnership(t *testing.T) {
	t.Run("refuses to capture a pane outside the attached session", func(t *testing.T) {
		// capturePaneById("%9") went straight to tmux, which resolves pane
		// ids server wide, so any pane on the machine came back.
		h := newHarness(t)
		sink := h.open(1)
		h.attachReady(1, sink, "work", nil)
		sink.reset()

		h.must(1, &client.PaneCapture{Type: "pane:capture", ID: "%9"})

		if got := h.tm.called("CapturePaneByID"); len(got) != 0 {
			t.Fatalf("captured %v", got)
		}
		wantError(t, sink.all()[0], CodePaneNotFound, `Pane "%9" not found`)
	})

	t.Run("still captures a pane that does belong to the session", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		h.attachReady(1, sink, "work", nil)
		sink.reset()

		h.must(1, &client.PaneCapture{Type: "pane:capture", ID: "%1"})

		if got := h.tm.called("CapturePaneByID"); !slices.Equal(got, []string{"CapturePaneByID %1"}) {
			t.Fatalf("calls = %v", got)
		}
		got := sink.all()[0].(*server.PaneCaptured)
		if got.ID != "%1" || got.Content != "PANE CONTENT" {
			t.Fatalf("reply = %+v", got)
		}
		// The ownership lookup lists every pane of the session, unscoped.
		if got := h.tm.called("ListPanes"); !slices.Contains(got, "ListPanes work ") {
			t.Fatalf("ListPanes calls = %v, want an unscoped listing", got)
		}
	})
}

// Ported from policy.test.ts.
func TestPolicy(t *testing.T) {
	t.Run("refuses a pane id with no attached session", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		h.must(1, &client.PaneCapture{Type: "pane:capture", ID: "%7"})
		wantError(t, sink.last(), CodeNotAttached, "No session attached")
	})

	t.Run("looks up an empty id like any other", func(t *testing.T) {
		// The relay refused only a non string id. "" went on to the attach
		// check and the lookup, and was not found.
		h := newHarness(t)
		sink := h.open(1)
		h.must(1, &client.PaneCapture{Type: "pane:capture"})
		wantError(t, sink.last(), CodeNotAttached, "No session attached")
		h.setAttached(1, "work")
		h.must(1, &client.PaneCapture{Type: "pane:capture"})
		wantError(t, sink.last(), CodePaneNotFound, `Pane "" not found`)
		h.must(1, &client.WindowSelect{Type: "window:select"})
		wantError(t, sink.last(), CodeWindowNotFound, `Window "" not found`)
		if got := h.tm.called("CapturePaneByID"); len(got) != 0 {
			t.Fatalf("captured %v", got)
		}
		if got := h.tm.called("SelectWindow"); len(got) != 0 {
			t.Fatalf("selected %v", got)
		}
	})

	t.Run("never gets an id message with no string id", func(t *testing.T) {
		// The relay answered INVALID_MESSAGE "Missing target id." here.
		// In Go, Decode refuses such a message at the hub, so the node
		// never sees it.
		for _, raw := range []string{
			`{"type":"pane:capture"}`,
			`{"type":"pane:select","id":null}`,
			`{"type":"pane:kill","id":7}`,
			`{"type":"window:select"}`,
			`{"type":"window:rename","id":["@1"],"name":"logs"}`,
		} {
			if msg, err := client.Decode([]byte(raw)); !errors.Is(err, protocol.ErrInvalid) {
				t.Errorf("Decode(%s) = %v, %v, want ErrInvalid", raw, msg, err)
			}
		}
	})

	t.Run("never leaks a session name through the refusal code", func(t *testing.T) {
		// A hidden clone and a missing session read the same, so the answer
		// does not tell which names exist.
		h := newHarness(t)
		sink := h.open(1)
		h.tm.set(func(f *fakeTmux) { f.missing["secret-prod"] = true })
		h.must(1, attachMsg("secret-prod", false))
		h.must(1, attachMsg("__tmuxde_clone", false))
		msgs := sink.all()
		if len(msgs) != 2 {
			t.Fatalf("got %v", typesOf(msgs))
		}
		wantError(t, msgs[0], CodeSessionNotFound, `Session "secret-prod" not found`)
		wantError(t, msgs[1], CodeSessionNotFound, `Session "__tmuxde_clone" not found`)
		if got := h.tm.called("SessionExists __tmuxde_clone"); len(got) != 0 {
			t.Fatalf("a clone name reached tmux: %v", got)
		}
		h.mu.Lock()
		n := len(h.attaches)
		h.mu.Unlock()
		if n != 0 {
			t.Fatalf("attacher ran %d times", n)
		}
	})
}

// TestOwnershipRule runs every id message against the rule of spec section
// 7: an attached session, then the id inside that session. A non string id
// never gets here, Decode refuses it. A failed lookup refuses too. A
// refused message never reaches tmux.
func TestOwnershipRule(t *testing.T) {
	type idMsg struct {
		name   string
		build  func(id string) client.Message
		pane   bool
		action string
	}
	msgs := []idMsg{
		{"pane:select", func(id string) client.Message { return &client.PaneSelect{Type: "pane:select", ID: id} }, true, "SelectPane"},
		{"pane:resize", func(id string) client.Message {
			return &client.PaneResize{Type: "pane:resize", ID: id, Direction: "U", Amount: 2}
		}, true, "ResizePane"},
		{"pane:kill", func(id string) client.Message { return &client.PaneKill{Type: "pane:kill", ID: id} }, true, "KillPane"},
		{"pane:swap", func(id string) client.Message { return &client.PaneSwap{Type: "pane:swap", ID: id, Direction: "D"} }, true, "SwapPane"},
		{"pane:capture", func(id string) client.Message { return &client.PaneCapture{Type: "pane:capture", ID: id} }, true, "CapturePaneByID"},
		{"pane:zoom", func(id string) client.Message {
			return &client.PaneZoom{Type: "pane:zoom", ID: &id, Zoomed: ptr(true)}
		}, true, "ZoomPane"},
		{"window:select", func(id string) client.Message { return &client.WindowSelect{Type: "window:select", ID: id} }, false, "SelectWindow"},
		{"window:kill", func(id string) client.Message { return &client.WindowKill{Type: "window:kill", ID: id} }, false, "KillWindow"},
		{"window:rename", func(id string) client.Message {
			return &client.WindowRename{Type: "window:rename", ID: id, Name: "logs"}
		}, false, "RenameWindow"},
	}
	cases := []struct {
		name     string
		attached bool
		// id is the id sent. "" is empty, not missing. For a pane message
		// the good id is %1, for a window message @1.
		paneID, windowID string
		lookupFails      bool
		code, text       string
	}{
		{"empty id, nothing attached", false, "", "", false, CodeNotAttached, "No session attached"},
		{"empty id", true, "", "", false, "", ""},
		{"nothing attached", false, "%1", "@1", false, CodeNotAttached, "No session attached"},
		{"foreign id", true, "%9", "@9", false, "", ""},
		{"lookup fails", true, "%1", "@1", true, "", ""},
		{"own id", true, "%1", "@1", false, "ok", ""},
	}
	for _, m := range msgs {
		for _, tc := range cases {
			if m.name == "pane:zoom" && tc.paneID == "" {
				// An empty zoom id means no id. It toggles the active pane.
				continue
			}
			t.Run(m.name+" "+tc.name, func(t *testing.T) {
				h := newHarness(t)
				sink := h.open(1)
				if tc.attached {
					h.setAttached(1, "work")
				}
				id, kind, list := tc.windowID, "Window", "ListWindows"
				if m.pane {
					id, kind, list = tc.paneID, "Pane", "ListPanes"
				}
				if tc.lookupFails {
					h.tm.set(func(f *fakeTmux) { f.errs[list] = errBoom })
				}

				h.must(1, m.build(id))

				code, text := tc.code, tc.text
				if code == "" {
					code, text = CodeWindowNotFound, `Window "`+id+`" not found`
					if m.pane {
						code, text = CodePaneNotFound, `Pane "`+id+`" not found`
					}
				}
				calls := h.tm.called(m.action)
				if code == "ok" {
					if len(calls) != 1 {
						t.Fatalf("%s calls = %v, want one", m.action, calls)
					}
					for _, msg := range sink.all() {
						if e, ok := msg.(*server.Error); ok {
							t.Fatalf("own %s refused: %s %s", kind, e.Code, e.Message)
						}
					}
					return
				}
				if len(calls) != 0 {
					t.Fatalf("refused message reached tmux: %v", calls)
				}
				msgs := sink.all()
				if len(msgs) != 1 {
					t.Fatalf("got %v, want one error", typesOf(msgs))
				}
				wantError(t, msgs[0], code, text)
			})
		}
	}
}

// Ported from message-router.test.ts, describe "tmux:scroll".
func TestTmuxScroll(t *testing.T) {
	attached := func(t *testing.T) (*harness, *fakeSink) {
		h := newHarness(t)
		sink := h.open(1)
		h.setAttached(1, "work")
		return h, sink
	}

	t.Run("scrolls the session the connection is attached to", func(t *testing.T) {
		h, _ := attached(t)
		h.must(1, &client.TmuxScroll{Type: "tmux:scroll", Lines: 7})
		if got := h.tm.called("ScrollHistory"); !slices.Equal(got, []string{"ScrollHistory work 7"}) {
			t.Fatalf("calls = %v", got)
		}
	})

	t.Run("passes a negative count through, so scrolling back down works", func(t *testing.T) {
		h, _ := attached(t)
		h.must(1, &client.TmuxScroll{Type: "tmux:scroll", Lines: -3})
		if got := h.tm.called("ScrollHistory"); !slices.Equal(got, []string{"ScrollHistory work -3"}) {
			t.Fatalf("calls = %v", got)
		}
	})

	t.Run("refuses when nothing is attached rather than guessing a session", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		h.must(1, &client.TmuxScroll{Type: "tmux:scroll", Lines: 7})
		if got := h.tm.called("ScrollHistory"); len(got) != 0 {
			t.Fatalf("calls = %v", got)
		}
		wantError(t, sink.last(), CodeNotAttached, "No session attached")
	})

	t.Run("reports where the view ended up, so the scrollbar can draw itself", func(t *testing.T) {
		h, sink := attached(t)
		h.must(1, &client.TmuxScroll{Type: "tmux:scroll", Lines: 7})
		want := &server.TmuxScrollState{Type: "tmux:scroll-state", Position: 12, HistorySize: 400, PaneHeight: 40, InMode: true}
		if got := sink.last().(*server.TmuxScrollState); *got != *want {
			t.Fatalf("reply = %+v, want %+v", got, want)
		}
	})

	t.Run("jumps to an absolute position for a scrollbar drag", func(t *testing.T) {
		h, sink := attached(t)
		h.must(1, &client.TmuxScrollTo{Type: "tmux:scroll-to", Position: 200})
		if got := h.tm.called("ScrollToPosition"); !slices.Equal(got, []string{"ScrollToPosition work 200"}) {
			t.Fatalf("calls = %v", got)
		}
		if got := sink.last().(*server.TmuxScrollState); got.Position != 200 {
			t.Fatalf("reply = %+v", got)
		}
	})

	t.Run("answers a bare state request without moving anything", func(t *testing.T) {
		h, sink := attached(t)
		h.must(1, &client.TmuxScrollState{Type: "tmux:scroll-state"})
		if got := append(h.tm.called("ScrollHistory"), h.tm.called("ScrollToPosition")...); len(got) != 0 {
			t.Fatalf("moved: %v", got)
		}
		if got := sink.last().(*server.TmuxScrollState); got.Position != 0 || got.HistorySize != 400 {
			t.Fatalf("reply = %+v", got)
		}
	})

	t.Run("reports position 0 outside copy mode, whatever tmux last remembered", func(t *testing.T) {
		h, sink := attached(t)
		h.tm.set(func(f *fakeTmux) { f.state.Position = 99 })
		h.must(1, &client.TmuxScrollState{Type: "tmux:scroll-state"})
		if got := sink.last().(*server.TmuxScrollState); got.Position != 0 || got.InMode {
			t.Fatalf("reply = %+v", got)
		}
	})

	t.Run("leaves copy mode on request", func(t *testing.T) {
		h, sink := attached(t)
		h.must(1, &client.TmuxExitCopyMode{Type: "tmux:exit-copy-mode"})
		if got := h.tm.called("ExitCopyMode"); !slices.Equal(got, []string{"ExitCopyMode work"}) {
			t.Fatalf("calls = %v", got)
		}
		if got := h.tm.called("ReadScrollState"); len(got) != 1 {
			t.Fatalf("state reads = %v, want a fresh state", got)
		}
		if got := sink.types(); !slices.Equal(got, []string{"tmux:scroll-state"}) {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("refuses to leave copy mode with nothing attached", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		h.must(1, &client.TmuxExitCopyMode{Type: "tmux:exit-copy-mode"})
		if got := h.tm.called("ExitCopyMode"); len(got) != 0 {
			t.Fatalf("calls = %v", got)
		}
		wantError(t, sink.last(), CodeNotAttached, "No session attached")
	})

	t.Run("enters copy mode and sends the prefix without a reply", func(t *testing.T) {
		h, sink := attached(t)
		h.must(1, &client.TmuxCopyMode{Type: "tmux:copy-mode"})
		h.must(1, &client.TmuxPrefix{Type: "tmux:prefix"})
		if got := h.tm.called("EnterCopyMode"); !slices.Equal(got, []string{"EnterCopyMode work"}) {
			t.Fatalf("calls = %v", got)
		}
		if got := h.tm.called("SendPrefix"); !slices.Equal(got, []string{"SendPrefix work"}) {
			t.Fatalf("calls = %v", got)
		}
		if got := sink.all(); len(got) != 0 {
			t.Fatalf("got %v", typesOf(got))
		}
	})

	t.Run("a tmux failure is a handler error", func(t *testing.T) {
		h, _ := attached(t)
		h.tm.set(func(f *fakeTmux) { f.errs["ScrollHistory"] = errBoom })
		if err := h.handle(1, &client.TmuxScroll{Type: "tmux:scroll", Lines: 1}); err != errBoom {
			t.Fatalf("Handle = %v, want the tmux error as is", err)
		}
	})
}

// Ported from message-router.test.ts, describe "window scoping". pane:zoom
// with an id now passes the ownership rule, so the panes include %4.
func TestWindowScoping(t *testing.T) {
	setup := func(t *testing.T) (*harness, *fakeSink) {
		h := newHarness(t)
		sink := h.open(1)
		h.setAttached(1, "work")
		h.tm.set(func(f *fakeTmux) {
			f.windows = []protocol.WindowInfo{window("@1", 0, false), window("@2", 1, true), window("@3", 2, false)}
			f.current = "@2"
			// What an unscoped list-panes -s returns: one active pane per
			// window. Anything that still guesses from it fails below.
			f.panes = []protocol.PaneInfo{pane("%1", "@1"), pane("%2", "@2"), pane("%3", "@3"), pane("%4", "@2")}
			f.panes[3].Active = false
		})
		return h, sink
	}

	t.Run("scopes pane:list to the window tmux is actually showing", func(t *testing.T) {
		h, sink := setup(t)
		h.must(1, &client.PaneList{Type: "pane:list"})
		reply := sink.last().(*server.PaneList)
		if reply.WindowID != "@2" {
			t.Fatalf("windowId = %s, want @2", reply.WindowID)
		}
		var ids []string
		active := 0
		for _, p := range reply.Panes {
			ids = append(ids, p.ID)
			if p.Active {
				active++
			}
		}
		if !slices.Equal(ids, []string{"%2", "%4"}) || active != 1 {
			t.Fatalf("panes = %v with %d active", ids, active)
		}
	})

	t.Run("does not snap the window back to the first one after window:select", func(t *testing.T) {
		h, sink := setup(t)
		h.tm.set(func(f *fakeTmux) {
			f.current = "@3"
			f.windows = []protocol.WindowInfo{window("@1", 0, false), window("@2", 1, false), window("@3", 2, true)}
		})
		h.must(1, &client.WindowSelect{Type: "window:select", ID: "@3"})

		var changed []*server.PaneChanged
		for _, m := range sink.all() {
			if p, ok := m.(*server.PaneChanged); ok {
				changed = append(changed, p)
			}
		}
		// The old code sent @1 here and undid the window:changed before it.
		if len(changed) != 1 || changed[0].WindowID != "@3" {
			t.Fatalf("pane:changed = %+v, want one for @3", changed)
		}
		if st := h.state(1); st.active != "@3" {
			t.Fatalf("activeWindowId = %q", st.active)
		}
	})

	t.Run("selects a pane through the attached session, so its window shows", func(t *testing.T) {
		h, sink := setup(t)
		h.tm.set(func(f *fakeTmux) { f.current = "@3" })
		h.must(1, &client.PaneSelect{Type: "pane:select", ID: "%3"})

		if got := h.tm.called("SelectPane"); !slices.Equal(got, []string{"SelectPane work %3"}) {
			t.Fatalf("calls = %v", got)
		}
		if got := sink.types(); !slices.Equal(got, []string{"window:changed", "pane:changed"}) {
			t.Fatalf("got %v", got)
		}
		if got := sink.last().(*server.PaneChanged); got.WindowID != "@3" {
			t.Fatalf("windowId = %s", got.WindowID)
		}
		if st := h.state(1); st.active != "@3" {
			t.Fatalf("activeWindowId = %q", st.active)
		}
	})

	t.Run("publishes the window list alongside every pane change", func(t *testing.T) {
		h, sink := setup(t)
		h.must(1, &client.PaneZoom{Type: "pane:zoom"})
		if got := sink.types(); !slices.Equal(got, []string{"window:changed", "pane:changed"}) {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("passes the pane and the wanted state through to tmux", func(t *testing.T) {
		// Both make the request idempotent. Dropping either turns it back
		// into a toggle of whatever pane tmux had active.
		h, _ := setup(t)
		h.must(1, &client.PaneZoom{Type: "pane:zoom", ID: ptr("%4"), Zoomed: ptr(true)})
		z := h.tm.zoomArgs
		if z.session != "work" || z.pane != "%4" || z.desired == nil || !*z.desired {
			t.Fatalf("zoom = %+v, want work %%4 true", z)
		}
	})

	t.Run("asks for a toggle when an older client names neither", func(t *testing.T) {
		h, _ := setup(t)
		h.must(1, &client.PaneZoom{Type: "pane:zoom"})
		z := h.tm.zoomArgs
		if z.session != "work" || z.pane != "" || z.desired != nil {
			t.Fatalf("zoom = %+v, want a toggle of the session target", z)
		}
	})

	t.Run("carries zoomed false rather than dropping it as falsy", func(t *testing.T) {
		h, _ := setup(t)
		h.must(1, &client.PaneZoom{Type: "pane:zoom", ID: ptr("%4"), Zoomed: ptr(false)})
		z := h.tm.zoomArgs
		if z.pane != "%4" || z.desired == nil || *z.desired {
			t.Fatalf("zoom = %+v, want %%4 false", z)
		}
	})

	t.Run("steps windows relatively, so a stale client list cannot mistarget", func(t *testing.T) {
		h, sink := setup(t)
		h.must(1, &client.WindowStep{Type: "window:step", Delta: 1})
		if got := h.tm.called("StepWindow"); !slices.Equal(got, []string{"StepWindow work 1"}) {
			t.Fatalf("calls = %v", got)
		}
		if got := h.tm.called("SelectWindow"); len(got) != 0 {
			t.Fatalf("selected %v", got)
		}
		if got := sink.types(); !slices.Equal(got, []string{"window:changed", "pane:changed"}) {
			t.Fatalf("got %v", got)
		}
		if st := h.state(1); st.active != "@2" {
			t.Fatalf("activeWindowId = %q", st.active)
		}
	})

	t.Run("steps backwards on a negative delta", func(t *testing.T) {
		h, _ := setup(t)
		h.must(1, &client.WindowStep{Type: "window:step", Delta: -1})
		if got := h.tm.called("StepWindow"); !slices.Equal(got, []string{"StepWindow work -1"}) {
			t.Fatalf("calls = %v", got)
		}
	})

	t.Run("steps panes within the current window only", func(t *testing.T) {
		h, sink := setup(t)
		h.must(1, &client.PaneStep{Type: "pane:step", Delta: 1})
		if got := h.tm.called("StepPane"); !slices.Equal(got, []string{"StepPane work 1"}) {
			t.Fatalf("calls = %v", got)
		}
		var ids []string
		for _, p := range sink.last().(*server.PaneChanged).Panes {
			ids = append(ids, p.ID)
		}
		if !slices.Equal(ids, []string{"%2", "%4"}) {
			t.Fatalf("panes = %v", ids)
		}
	})

	t.Run("refuses to step with nothing attached", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		h.must(1, &client.WindowStep{Type: "window:step", Delta: 1})
		h.must(1, &client.PaneStep{Type: "pane:step", Delta: 1})
		if got := append(h.tm.called("StepWindow"), h.tm.called("StepPane")...); len(got) != 0 {
			t.Fatalf("stepped: %v", got)
		}
		for _, m := range sink.all() {
			wantError(t, m, CodeNotAttached, "No session attached")
		}
		if len(sink.all()) != 2 {
			t.Fatalf("got %v", sink.types())
		}
	})

	t.Run("keeps the active window when another one is killed", func(t *testing.T) {
		h, _ := setup(t)
		h.must(1, &client.WindowSelect{Type: "window:select", ID: "@3"})
		h.must(1, &client.WindowKill{Type: "window:kill", ID: "@1"})
		if st := h.state(1); st.active != "@3" {
			t.Fatalf("activeWindowId = %q, want @3", st.active)
		}
		h.must(1, &client.WindowKill{Type: "window:kill", ID: "@3"})
		if st := h.state(1); st.active != "@2" {
			t.Fatalf("activeWindowId = %q, want the window tmux shows", st.active)
		}
	})
}

// TestLayoutMessages runs every message that ends in announceLayout and
// checks the tmux call and the announcement.
func TestLayoutMessages(t *testing.T) {
	tests := []struct {
		msg  client.Message
		call string
	}{
		{&client.PaneSplit{Type: "pane:split", Direction: "h"}, "SplitPane work h"},
		{&client.PaneSelect{Type: "pane:select", ID: "%1"}, "SelectPane work %1"},
		{&client.PaneZoom{Type: "pane:zoom", ID: ptr("%1")}, "ZoomPane work %1"},
		{&client.PaneResize{Type: "pane:resize", ID: "%1", Direction: "L", Amount: 5}, "ResizePane %1 L 5"},
		{&client.PaneKill{Type: "pane:kill", ID: "%1"}, "KillPane %1"},
		{&client.PaneStep{Type: "pane:step", Delta: -1}, "StepPane work -1"},
		{&client.PaneSwap{Type: "pane:swap", ID: "%1", Direction: "U"}, "SwapPane %1 U"},
		{&client.WindowStep{Type: "window:step", Delta: 1}, "StepWindow work 1"},
		{&client.WindowCreate{Type: "window:create", Name: ptr("logs")}, "CreateWindow work logs"},
		{&client.WindowCreate{Type: "window:create"}, "CreateWindow work "},
		{&client.WindowSelect{Type: "window:select", ID: "@1"}, "SelectWindow @1"},
		{&client.WindowKill{Type: "window:kill", ID: "@1"}, "KillWindow @1"},
		{&client.WindowRename{Type: "window:rename", ID: "@1", Name: "logs"}, "RenameWindow @1 logs"},
		{&client.WindowLayout{Type: "window:layout", Preset: "tiled"}, "SelectLayout work tiled"},
		{&client.LayoutRotate{Type: "layout:rotate"}, "RotateLayout work"},
	}
	for _, tt := range tests {
		t.Run(tt.call, func(t *testing.T) {
			h := newHarness(t)
			sink := h.open(1)
			h.setAttached(1, "work")
			h.must(1, tt.msg)
			method, _, _ := strings.Cut(tt.call, " ")
			if got := h.tm.called(method); !slices.Equal(got, []string{tt.call}) {
				t.Fatalf("calls = %q, want %q", got, tt.call)
			}
			msgs := sink.all()
			if got := typesOf(msgs); !slices.Equal(got, []string{"window:changed", "pane:changed"}) {
				t.Fatalf("got %v", got)
			}
			w := msgs[0].(*server.WindowChanged)
			p := msgs[1].(*server.PaneChanged)
			if w.SessionName != "work" || len(w.Windows) != 1 || p.WindowID != "@1" || len(p.Panes) != 1 {
				t.Fatalf("announce = %+v %+v", w, p)
			}
		})
		t.Run(tt.call+" unattached", func(t *testing.T) {
			h := newHarness(t)
			sink := h.open(1)
			h.must(1, tt.msg)
			wantError(t, sink.last(), CodeNotAttached, "No session attached")
		})
	}
}

// TestListReplies covers window:list, pane:list and session:windows, and
// that an empty tmux answer goes out as [] rather than null.
func TestListReplies(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)

	h.must(1, &client.WindowList{Type: "window:list"})
	h.must(1, &client.PaneList{Type: "pane:list"})
	for _, m := range sink.all() {
		wantError(t, m, CodeNotAttached, "No session attached")
	}
	sink.reset()

	h.setAttached(1, "work")
	h.tm.set(func(f *fakeTmux) {
		f.windows = nil
		f.panes = nil
	})
	h.must(1, &client.WindowList{Type: "window:list"})
	h.must(1, &client.PaneList{Type: "pane:list"})
	h.must(1, &client.SessionWindows{Type: "session:windows", Name: "other"})
	msgs := sink.all()
	if got := typesOf(msgs); !slices.Equal(got, []string{"window:list", "pane:list", "session:windows"}) {
		t.Fatalf("got %v", got)
	}
	if w := msgs[0].(*server.WindowList); w.Windows == nil || w.SessionName != "work" {
		t.Fatalf("window:list = %+v", w)
	}
	if p := msgs[1].(*server.PaneList); p.Panes == nil || p.WindowID != "@1" {
		t.Fatalf("pane:list = %+v", p)
	}
	if s := msgs[2].(*server.SessionWindows); s.Name != "other" || s.Windows == nil || s.Panes == nil {
		t.Fatalf("session:windows = %+v", s)
	}
	if got := h.tm.called("ListPanes other"); !slices.Equal(got, []string{"ListPanes other "}) {
		t.Fatalf("session:windows pane listing = %v, want unscoped", got)
	}
}

// TestSessionListHidesClones covers the clone filter of session:list.
func TestSessionListHidesClones(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	h.tm.set(func(f *fakeTmux) {
		f.sessions = append(f.sessions, session("__tmuxde_abc", "$9"))
	})
	h.must(1, &client.SessionList{Type: "session:list"})
	var names []string
	for _, s := range sink.last().(*server.SessionList).Sessions {
		names = append(names, s.Name)
	}
	if !slices.Equal(names, []string{"work", "other"}) {
		t.Fatalf("sessions = %v", names)
	}

	// No sessions at all is [], never null.
	h.tm.set(func(f *fakeTmux) { f.sessions = nil })
	h.must(1, &client.SessionList{Type: "session:list"})
	if got := sink.last().(*server.SessionList).Sessions; got == nil || len(got) != 0 {
		t.Fatalf("sessions = %#v, want empty", got)
	}
}

func TestSessionCreateArgs(t *testing.T) {
	h := newHarness(t)
	h.open(1)
	h.tm.set(func(f *fakeTmux) { f.created = session("new", "$7") })
	h.must(1, &client.SessionCreate{Type: "session:create"})
	h.must(1, &client.SessionCreate{Type: "session:create", Name: ptr("n"), Cwd: ptr("/tmp"), Command: ptr("htop")})
	if got := h.tm.called("CreateSession"); !slices.Equal(got, []string{"CreateSession   ", "CreateSession n /tmp htop"}) {
		t.Fatalf("calls = %q", got)
	}
}

func TestSessionRenameMissing(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	h.tm.set(func(f *fakeTmux) { f.missing["old"] = true })
	h.must(1, &client.SessionRename{Type: "session:rename", OldName: "old", NewName: "new"})
	wantError(t, sink.last(), CodeSessionNotFound, `Session "old" not found`)
	if got := h.tm.called("RenameSession"); len(got) != 0 {
		t.Fatalf("calls = %v", got)
	}
}

func TestSessionKillError(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	h.tm.set(func(f *fakeTmux) { f.errs["KillSession"] = errBoom })
	if err := h.handle(1, &client.SessionKill{Type: "session:kill", Name: "work"}); err != errBoom {
		t.Fatalf("Handle = %v, want the tmux error", err)
	}
	if got := sink.all(); len(got) != 0 {
		t.Fatalf("got %v", typesOf(got))
	}
}
