package local

import (
	"context"
	"fmt"
	"slices"

	"tmuxde/internal/node/tmux"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// Error codes the node sends as server.Error. The texts match the relay.
const (
	CodeNotAttached     = "NOT_ATTACHED"
	CodeSessionNotFound = "SESSION_NOT_FOUND"
	CodePaneNotFound    = "PANE_NOT_FOUND"
	CodeWindowNotFound  = "WINDOW_NOT_FOUND"
	CodePtySpawnFailed  = "PTY_SPAWN_FAILED"

	textNotAttached = "No session attached"
)

func errorMsg(code, text string) *server.Error {
	return &server.Error{Type: "error", Code: code, Message: text}
}

func notAttached() *server.Error { return errorMsg(CodeNotAttached, textNotAttached) }

// The relay built these with template strings. %q would escape quotes and
// non ASCII runes differently, so they are concatenated.
func sessionNotFound(name string) string { return `Session "` + name + `" not found` }
func paneNotFound(id string) string      { return `Pane "` + id + `" not found` }
func windowNotFound(id string) string    { return `Window "` + id + `" not found` }

// wrapf adds context to an unexpected error. The text reaches the browser
// as HANDLER_ERROR.
func wrapf(err error, what string) error { return fmt.Errorf("%s: %w", what, err) }

// orEmpty turns a nil slice into an empty one. The browser refuses null
// where the schema has an array, and Encode refuses to send it.
func orEmpty[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// route dispatches a terminal message by its type.
func (n *Node) route(ctx context.Context, c *conn, msg client.Message) error {
	switch m := msg.(type) {
	case *client.SessionList:
		return n.sessionList(ctx, c)
	case *client.SessionCreate:
		return n.sessionCreate(ctx, c, m)
	case *client.SessionAttach:
		return n.attach(ctx, c, m)
	case *client.SessionDetach:
		// Cleared even with no live pty, and nothing is sent.
		c.detach()
		return nil
	case *client.SessionKill:
		return n.sessionKill(ctx, c, m)
	case *client.SessionRename:
		return n.sessionRename(ctx, c, m)
	case *client.SessionWindows:
		return n.sessionWindows(ctx, c, m)

	case *client.WindowList:
		return n.withSession(ctx, c, func(s string) error {
			windows, err := n.tmux.ListWindows(ctx, s)
			if err != nil {
				return err
			}
			return c.send(ctx, &server.WindowList{Type: "window:list", Windows: orEmpty(windows), SessionName: s})
		})
	case *client.WindowCreate:
		return n.withSession(ctx, c, func(s string) error {
			name := ""
			if m.Name != nil {
				name = *m.Name
			}
			if err := n.tmux.CreateWindow(ctx, s, name); err != nil {
				return err
			}
			wid, err := n.announceLayout(ctx, c, s)
			if err != nil {
				return err
			}
			c.setActiveWindow(wid)
			return nil
		})
	case *client.WindowSelect:
		return n.withWindow(ctx, c, m.ID, func(s string) error {
			if err := n.tmux.SelectWindow(ctx, m.ID); err != nil {
				return err
			}
			c.setActiveWindow(m.ID)
			_, err := n.announceLayout(ctx, c, s)
			return err
		})
	case *client.WindowStep:
		return n.withSession(ctx, c, func(s string) error {
			// Relative, so a window killed since the browser listed them
			// can never be the target.
			if err := n.tmux.StepWindow(ctx, s, m.Delta); err != nil {
				return err
			}
			wid, err := n.announceLayout(ctx, c, s)
			if err != nil {
				return err
			}
			c.setActiveWindow(wid)
			return nil
		})
	case *client.WindowKill:
		return n.withWindow(ctx, c, m.ID, func(s string) error {
			if err := n.tmux.KillWindow(ctx, m.ID); err != nil {
				return err
			}
			wid, err := n.announceLayout(ctx, c, s)
			if err != nil {
				return err
			}
			c.replaceActiveWindow(m.ID, wid)
			return nil
		})
	case *client.WindowRename:
		return n.withWindow(ctx, c, m.ID, func(s string) error {
			if err := n.tmux.RenameWindow(ctx, m.ID, m.Name); err != nil {
				return err
			}
			_, err := n.announceLayout(ctx, c, s)
			return err
		})
	case *client.WindowLayout:
		return n.withSession(ctx, c, func(s string) error {
			if err := n.tmux.SelectLayout(ctx, s, m.Preset); err != nil {
				return err
			}
			_, err := n.announceLayout(ctx, c, s)
			return err
		})
	case *client.LayoutRotate:
		return n.withSession(ctx, c, func(s string) error {
			if err := n.tmux.RotateLayout(ctx, s); err != nil {
				return err
			}
			_, err := n.announceLayout(ctx, c, s)
			return err
		})

	case *client.PaneList:
		return n.withSession(ctx, c, func(s string) error {
			wid, panes, err := n.tmux.CurrentWindowPanes(ctx, s)
			if err != nil {
				return err
			}
			return c.send(ctx, &server.PaneList{Type: "pane:list", Panes: orEmpty(panes), WindowID: wid})
		})
	case *client.PaneSplit:
		return n.withSession(ctx, c, func(s string) error {
			if err := n.tmux.SplitPane(ctx, s, m.Direction); err != nil {
				return err
			}
			_, err := n.announceLayout(ctx, c, s)
			return err
		})
	case *client.PaneSelect:
		return n.withPane(ctx, c, m.ID, func(s string) error {
			// Through the session, so the pane's window is shown too.
			if err := n.tmux.SelectPane(ctx, s, m.ID); err != nil {
				return err
			}
			wid, err := n.announceLayout(ctx, c, s)
			if err != nil {
				return err
			}
			c.setActiveWindow(wid)
			return nil
		})
	case *client.PaneZoom:
		return n.paneZoom(ctx, c, m)
	case *client.PaneStep:
		return n.withSession(ctx, c, func(s string) error {
			if err := n.tmux.StepPane(ctx, s, m.Delta); err != nil {
				return err
			}
			_, err := n.announceLayout(ctx, c, s)
			return err
		})
	case *client.PaneResize:
		return n.withPane(ctx, c, m.ID, func(s string) error {
			if err := n.tmux.ResizePane(ctx, m.ID, m.Direction, m.Amount); err != nil {
				return err
			}
			_, err := n.announceLayout(ctx, c, s)
			return err
		})
	case *client.PaneKill:
		return n.withPane(ctx, c, m.ID, func(s string) error {
			if err := n.tmux.KillPane(ctx, m.ID); err != nil {
				return err
			}
			_, err := n.announceLayout(ctx, c, s)
			return err
		})
	case *client.PaneSwap:
		return n.withPane(ctx, c, m.ID, func(s string) error {
			if err := n.tmux.SwapPane(ctx, m.ID, m.Direction); err != nil {
				return err
			}
			_, err := n.announceLayout(ctx, c, s)
			return err
		})
	case *client.PaneCapture:
		return n.withPane(ctx, c, m.ID, func(string) error {
			// Plain text, 2000 lines: the package defaults.
			content, err := n.tmux.CapturePaneByID(ctx, m.ID, tmux.CaptureOptions{})
			if err != nil {
				return err
			}
			return c.send(ctx, &server.PaneCaptured{Type: "pane:captured", ID: m.ID, Content: content})
		})

	case *client.TerminalInput:
		return n.write(ctx, c, m.Data, true)
	case *client.TerminalResize:
		return n.resize(ctx, c, m)
	case *client.CommandSend:
		return n.write(ctx, c, m.Command+inputEnter, true)
	case *client.CommandInterrupt:
		if s := c.attachedSession(); s != "" {
			return n.tmux.SendInterrupt(ctx, s)
		}
		return nil
	case *client.CommandEOF:
		return n.write(ctx, c, inputEOF, false)
	case *client.CommandClear:
		return n.write(ctx, c, inputClear, false)
	case *client.CommandSuspend:
		return n.write(ctx, c, inputSuspend, false)

	case *client.RepoRequest:
		return n.repoRequest(ctx, c, m)
	case *client.RepoWatch:
		return n.repoWatch(ctx, c, m)
	case *client.RepoUnwatch:
		return n.repoUnwatch(c, m)

	case *client.TmuxPrefix:
		return n.withSession(ctx, c, func(s string) error {
			return n.tmux.SendPrefix(ctx, s)
		})
	case *client.TmuxCopyMode:
		return n.withSession(ctx, c, func(s string) error {
			return n.tmux.EnterCopyMode(ctx, s)
		})
	case *client.TmuxScroll:
		return n.withSession(ctx, c, func(s string) error {
			st, err := n.tmux.ScrollHistory(ctx, s, m.Lines)
			if err != nil {
				return err
			}
			return c.send(ctx, scrollState(st))
		})
	case *client.TmuxScrollTo:
		return n.withSession(ctx, c, func(s string) error {
			st, err := n.tmux.ScrollToPosition(ctx, s, m.Position)
			if err != nil {
				return err
			}
			return c.send(ctx, scrollState(st))
		})
	case *client.TmuxScrollState:
		return n.withSession(ctx, c, func(s string) error {
			st, err := n.tmux.ReadScrollState(ctx, s)
			if err != nil {
				return err
			}
			return c.send(ctx, scrollState(st))
		})
	case *client.TmuxExitCopyMode:
		return n.withSession(ctx, c, func(s string) error {
			if err := n.tmux.ExitCopyMode(ctx, s); err != nil {
				return err
			}
			// The scrollbar is drawn from this, and leaving copy mode is
			// when its thumb goes back to the bottom.
			st, err := n.tmux.ReadScrollState(ctx, s)
			if err != nil {
				return err
			}
			return c.send(ctx, scrollState(st))
		})
	}
	return fmt.Errorf("%w: %s", ErrNotImplemented, msg.WireType())
}

// scrollState is the tmux:scroll-state reply. Outside copy mode the view
// is at the bottom, whatever tmux last remembered.
func scrollState(st tmux.ScrollState) *server.TmuxScrollState {
	pos := 0
	if st.InMode {
		pos = max(st.Position, 0)
	}
	return &server.TmuxScrollState{
		Type:        "tmux:scroll-state",
		Position:    pos,
		HistorySize: max(st.HistorySize, 0),
		PaneHeight:  max(st.PaneHeight, 0),
		InMode:      st.InMode,
	}
}

// withSession runs fn with the attached session, or answers NOT_ATTACHED.
func (n *Node) withSession(ctx context.Context, c *conn, fn func(session string) error) error {
	s := c.attachedSession()
	if s == "" {
		return c.send(ctx, notAttached())
	}
	return fn(s)
}

// withPane applies the ownership rule to a pane id, then runs fn with the
// attached session.
func (n *Node) withPane(ctx context.Context, c *conn, id string, fn func(session string) error) error {
	return n.owned(ctx, c, id, true, fn)
}

// withWindow applies the ownership rule to a window id, then runs fn with
// the attached session.
func (n *Node) withWindow(ctx context.Context, c *conn, id string, fn func(session string) error) error {
	return n.owned(ctx, c, id, false, fn)
}

// owned is the ownership rule of policy.ts. tmux resolves pane and window
// ids server wide, so an id is refused unless it belongs to the attached
// session. Checks in order: an attached session, then the id in the
// session's unscoped pane list or its window list. A failed lookup refuses
// too. A missing or non string id never gets here, as Decode refuses it.
// An empty id is looked up like any other and is not found, as in the
// relay.
func (n *Node) owned(ctx context.Context, c *conn, id string, pane bool, fn func(session string) error) error {
	s := c.attachedSession()
	if s == "" {
		return c.send(ctx, notAttached())
	}
	var found bool
	var err error
	if pane {
		var panes []protocol.PaneInfo
		panes, err = n.tmux.ListPanes(ctx, s, "")
		found = slices.ContainsFunc(panes, func(p protocol.PaneInfo) bool { return p.ID == id })
	} else {
		var windows []protocol.WindowInfo
		windows, err = n.tmux.ListWindows(ctx, s)
		found = slices.ContainsFunc(windows, func(w protocol.WindowInfo) bool { return w.ID == id })
	}
	if err != nil {
		n.log.Warn("ownership lookup failed", "conn", c.id, "session", s, "error", err)
		found = false
	}
	switch {
	case found:
		return fn(s)
	case pane:
		return c.send(ctx, errorMsg(CodePaneNotFound, paneNotFound(id)))
	default:
		return c.send(ctx, errorMsg(CodeWindowNotFound, windowNotFound(id)))
	}
}

// paneZoom zooms by pane id and wanted state. The relay had no ownership
// check here. The Go port applies it when an id is named.
func (n *Node) paneZoom(ctx context.Context, c *conn, m *client.PaneZoom) error {
	run := func(paneID string) func(string) error {
		return func(s string) error {
			// A nil Zoomed asks for a toggle. false is kept, it is not a
			// toggle.
			if err := n.tmux.ZoomPane(ctx, s, paneID, m.Zoomed); err != nil {
				return err
			}
			_, err := n.announceLayout(ctx, c, s)
			return err
		}
	}
	// An empty id counts as none, as the relay's truthiness check did.
	if m.ID != nil && *m.ID != "" {
		return n.withPane(ctx, c, *m.ID, run(*m.ID))
	}
	return n.withSession(ctx, c, run(""))
}

func (n *Node) sessionList(ctx context.Context, c *conn) error {
	sessions, err := n.visibleSessions(ctx)
	if err != nil {
		return err
	}
	return c.send(ctx, &server.SessionList{Type: "session:list", Sessions: sessions})
}

// visibleSessions lists every session but the clones. They are plumbing
// and never shown to anyone.
func (n *Node) visibleSessions(ctx context.Context) ([]protocol.SessionInfo, error) {
	all, err := n.tmux.ListSessions(ctx)
	if err != nil {
		return nil, err
	}
	visible := make([]protocol.SessionInfo, 0, len(all))
	for _, s := range all {
		if !tmux.IsClone(s.Name) {
			visible = append(visible, s)
		}
	}
	return visible, nil
}

func (n *Node) sessionCreate(ctx context.Context, c *conn, m *client.SessionCreate) error {
	var name, cwd, command string
	if m.Name != nil {
		name = *m.Name
	}
	if m.Cwd != nil {
		cwd = *m.Cwd
	}
	if m.Command != nil {
		command = *m.Command
	}
	s, err := n.tmux.CreateSession(ctx, name, cwd, command)
	if err != nil {
		return err
	}
	msg := &server.SessionCreated{Type: "session:created", Session: s}
	if err := c.send(ctx, msg); err != nil {
		return err
	}
	if !tmux.IsClone(s.Name) {
		n.broadcast(n.others(c), func(*conn) []server.Message { return []server.Message{msg} })
	}
	return nil
}

func (n *Node) sessionKill(ctx context.Context, c *conn, m *client.SessionKill) error {
	if err := n.tmux.KillSession(ctx, m.Name); err != nil {
		return err
	}
	msg := &server.SessionKilled{Type: "session:killed", Name: m.Name}
	if err := c.send(ctx, msg); err != nil {
		return err
	}
	if !tmux.IsClone(m.Name) {
		n.broadcast(n.others(c), func(*conn) []server.Message { return []server.Message{msg} })
	}
	return nil
}

func (n *Node) sessionRename(ctx context.Context, c *conn, m *client.SessionRename) error {
	if !n.tmux.SessionExists(ctx, m.OldName) {
		return c.send(ctx, errorMsg(CodeSessionNotFound, sessionNotFound(m.OldName)))
	}
	if err := n.tmux.RenameSession(ctx, m.OldName, m.NewName); err != nil {
		return err
	}
	// Before the list goes out, so a browser that follows the rename finds
	// its connection under the new name.
	n.followRename(m.OldName, m.NewName)
	sessions, err := n.visibleSessions(ctx)
	if err != nil {
		return err
	}
	if err := c.send(ctx, &server.SessionList{Type: "session:list", Sessions: sessions}); err != nil {
		return err
	}
	// Each connection gets its own list. With the one full grant they are
	// all the same list, so it is built once.
	n.broadcast(n.others(c), func(*conn) []server.Message {
		return []server.Message{&server.SessionList{Type: "session:list", Sessions: sessions}}
	})
	return nil
}

func (n *Node) sessionWindows(ctx context.Context, c *conn, m *client.SessionWindows) error {
	windows, err := n.tmux.ListWindows(ctx, m.Name)
	if err != nil {
		return err
	}
	panes, err := n.tmux.ListPanes(ctx, m.Name, "")
	if err != nil {
		return err
	}
	return c.send(ctx, &server.SessionWindows{
		Type:    "session:windows",
		Name:    m.Name,
		Windows: orEmpty(windows),
		Panes:   orEmpty(panes),
	})
}
