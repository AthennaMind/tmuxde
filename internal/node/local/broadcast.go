package local

import (
	"context"
	"slices"
	"sync"

	"tmuxde/internal/node/tmux"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/server"
)

// broadcast sends each connection in list the messages build returns for
// it, in order. build may return nil to skip a connection. Sends run in
// parallel, so one stalled browser does not hold up the others, and
// broadcast returns once every send has ended. Each send runs under its
// recipient's context, so a recipient that closes ends its own send.
func (n *Node) broadcast(list []*conn, build func(*conn) []server.Message) {
	var wg sync.WaitGroup
	for _, c := range list {
		msgs := build(c)
		if len(msgs) == 0 {
			continue
		}
		wg.Go(func() {
			if err := c.send(c.ctx, msgs...); err != nil && c.ctx.Err() == nil {
				n.log.Debug("broadcast not delivered", "conn", c.id, "type", msgs[0].WireType(), "error", err)
			}
		})
	}
	wg.Wait()
}

// attachedTo builds the same messages for connections attached to session
// and nothing for the rest.
func attachedTo(session string, msgs ...server.Message) func(*conn) []server.Message {
	return func(c *conn) []server.Message {
		if c.attachedSession() != session {
			return nil
		}
		return msgs
	}
}

// announceLayout publishes the window list and the panes of the window
// tmux shows: window:changed then pane:changed, to the sender first and
// then to every other connection attached to the same session. tmux state
// is shared, so a second viewer that missed a window switch would draw a
// stale tab strip. It returns the id of the window tmux shows.
func (n *Node) announceLayout(ctx context.Context, c *conn, session string) (string, error) {
	windows, err := n.tmux.ListWindows(ctx, session)
	if err != nil {
		return "", err
	}
	// The window tmux reports, not a guess from pane_active. That flag is
	// per window, and the guess always picked the first window.
	wid, panes, err := n.tmux.CurrentWindowPanes(ctx, session)
	if err != nil {
		return "", err
	}
	wmsg := &server.WindowChanged{Type: "window:changed", Windows: orEmpty(windows), SessionName: session}
	pmsg := &server.PaneChanged{Type: "pane:changed", Panes: orEmpty(panes), WindowID: wid}
	if err := c.send(ctx, wmsg, pmsg); err != nil {
		return "", err
	}
	n.broadcast(n.others(c), attachedTo(session, wmsg, pmsg))
	return wid, nil
}

// watched lists the sessions some connection is attached to. The monitor
// polls windows of those only.
func (n *Node) watched() []string {
	seen := map[string]bool{}
	for _, c := range n.others(nil) {
		if s := c.attachedSession(); s != "" {
			seen[s] = true
		}
	}
	names := make([]string, 0, len(seen))
	for s := range seen {
		names = append(names, s)
	}
	slices.Sort(names)
	return names
}

// sessionExited tells every connection not attached to name that it is
// gone. The attached one learns from its own pty exit, with the code.
func (n *Node) sessionExited(name string) {
	if tmux.IsClone(name) {
		return
	}
	msg := &server.SessionExited{Type: "session:exited", Name: name}
	n.broadcast(n.others(nil), func(c *conn) []server.Message {
		if c.attachedSession() == name {
			return nil
		}
		return []server.Message{msg}
	})
}

// followRename moves every connection attached to oldName over to newName.
// The tmux client behind each pty stays on the session whatever it is
// called. Without this, window and pane messages and the monitor's window
// poll kept using the old name and failed until the browser attached again.
// The router calls it for a rename made in a browser, the monitor for one
// made anywhere else. Two renames inside one session poll can name a
// middle name no connection holds. The browser follows by session id and
// attaches again under the new name, which mends that too.
func (n *Node) followRename(oldName, newName string) {
	if oldName == "" || newName == "" || oldName == newName {
		return
	}
	for _, c := range n.others(nil) {
		if c.renameAttached(oldName, newName) {
			n.log.Debug("connection follows session rename", "conn", c.id, "oldName", oldName, "newName", newName)
		}
	}
}

// sessionsChanged sends the session list to every connection. The monitor
// calls it when the name, window count or attached flag of any session
// moved, so a window opened or closed anywhere shows in the session list.
func (n *Node) sessionsChanged(all []protocol.SessionInfo) {
	visible := make([]protocol.SessionInfo, 0, len(all))
	for _, s := range all {
		if !tmux.IsClone(s.Name) {
			visible = append(visible, s)
		}
	}
	msg := &server.SessionList{Type: "session:list", Sessions: visible}
	n.broadcast(n.others(nil), func(*conn) []server.Message { return []server.Message{msg} })
}

// sessionCreated tells every connection about a new session.
func (n *Node) sessionCreated(s protocol.SessionInfo) {
	if tmux.IsClone(s.Name) {
		return
	}
	msg := &server.SessionCreated{Type: "session:created", Session: s}
	n.broadcast(n.others(nil), func(*conn) []server.Message { return []server.Message{msg} })
}

// windowsChanged pushes a window change made outside the browser to the
// connections attached to name. The pane layout goes with it: only a pane
// listing says which pane is active and which one is zoomed, and sending
// the window half alone left a pane drawn as zoomed after an unzoom on the
// machine. A failed pane listing is dropped. The session may have died
// between the poll and the listing, and the exit path covers that.
func (n *Node) windowsChanged(ctx context.Context, name string, windows []protocol.WindowInfo) {
	if tmux.IsClone(name) {
		return
	}
	var recipients []*conn
	for _, c := range n.others(nil) {
		if c.attachedSession() == name {
			recipients = append(recipients, c)
		}
	}
	if len(recipients) == 0 {
		return
	}
	msgs := []server.Message{&server.WindowChanged{Type: "window:changed", Windows: orEmpty(windows), SessionName: name}}
	if n.tmux != nil {
		if wid, panes, err := n.tmux.CurrentWindowPanes(ctx, name); err == nil {
			msgs = append(msgs, &server.PaneChanged{Type: "pane:changed", Panes: orEmpty(panes), WindowID: wid})
		} else {
			n.log.Debug("pane listing after a window change failed", "session", name, "error", err)
		}
	}
	n.broadcast(recipients, attachedTo(name, msgs...))
}
