package local

import (
	"context"
	"errors"
	"os"
	"strings"
	"syscall"

	"tmuxde/internal/node/pty"
	"tmuxde/internal/node/tmux"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// captureLines is the history replayed on attach, as the relay did.
const captureLines = 2000

// Input the command messages type into the pty.
const (
	inputEnter   = "\r"
	inputEOF     = "\x04"
	inputClear   = "\x1b[2J\x1b[H"
	inputSuspend = "\x1a"
)

// attach runs session:attach. The steps follow message-router.ts. The
// differences are on purpose: ready, output, exit and spawn errors only
// act for the current attachment, and teardown waits for the old pump.
func (n *Node) attach(ctx context.Context, c *conn, m *client.SessionAttach) error {
	// 1. Tear down the old pty and clear the state first. Every step below
	// can fail, and a stale name would point later handlers at a session
	// this connection is no longer attached to.
	c.detach()

	// 2. A clone is never an attach target. Both refusals read the same,
	// so the answer does not tell a clone from a missing session.
	if tmux.IsClone(m.Name) || !n.tmux.SessionExists(ctx, m.Name) {
		return c.send(ctx, errorMsg(CodeSessionNotFound, sessionNotFound(m.Name)))
	}

	// 3. Capture before the pty exists. A failed capture must not abort
	// the attach. The old pty is gone already, so that would leave a dead
	// terminal.
	var captured string
	if m.Capture != nil && *m.Capture {
		out, err := n.tmux.CapturePane(ctx, m.Name, tmux.CaptureOptions{Lines: captureLines, Escapes: true})
		if err != nil {
			n.log.Warn("capture-pane failed, attaching without replay", "conn", c.id, "session", m.Name, "error", err)
		} else {
			captured = replayText(out)
		}
	}

	// 4. Spawn under the connection context, not the message context. The
	// pty outlives this message. -N keeps the attach client from starting
	// a tmux server when the server ended after the check above. Only
	// create starts one, outside the unit. See tmux.Launcher.
	opts := pty.Options{Socket: n.cfg.TmuxSocket, NoStart: n.tmux.NoStartFlag(ctx), Logger: n.log}
	if m.Size != nil {
		opts.Cols, opts.Rows = m.Size.Cols, m.Size.Rows
	}
	b, err := n.attacher(c.ctx, m.Name, opts)
	if err != nil {
		if c.ctx.Err() != nil {
			return err
		}
		return c.send(ctx, errorMsg(CodePtySpawnFailed, err.Error()))
	}

	// 5. Make it the live attachment. Size comes from the message, so a
	// resize to the same size is dropped.
	a, ok := c.install(m.Name, b, m.Size)
	if !ok {
		b.MarkDetaching()
		_ = b.Close()
		return nil
	}

	// 6 to 9 run in the pump.
	var attachID *string
	if m.AttachID != nil && *m.AttachID != "" {
		id := *m.AttachID
		attachID = &id
	}
	go n.pump(c, a, attachID, captured)
	return nil
}

// replayText makes capture-pane output safe to write to a terminal.
// capture-pane ends its lines with a bare LF. A terminal moves down on LF
// and keeps the column, so every line started where the previous one ended
// and the replay drew as a staircase. That showed in the browser's normal
// buffer once tmux left the alternate screen, above "[exited]". xterm.js
// keeps convertEol off on purpose, so the replay brings its own CR.
func replayText(s string) string {
	if !strings.Contains(s, "\n") {
		return s
	}
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\r\n")
}

// pump is the one goroutine of an attachment. It waits for ready, sends
// the ack and the replay, forwards output in order and reports the end.
// It returns early once the attachment is torn down or the connection
// closes. A sink that blocks stops the pump, the pump stops draining the
// bridge and the bridge stops reading the pty: that is the backpressure.
func (n *Node) pump(c *conn, a *attachment, attachID *string, captured string) {
	defer close(a.done)
	b := a.bridge

	switch waitReady(c.ctx, a, b) {
	case readyStop:
		return
	case readyFired:
		if a.stopped() {
			return
		}
		// Ack first, then replay. The browser drops output until the ack,
		// so a replay sent ahead of it never painted.
		ack := &server.SessionAttached{Type: "session:attached", Name: a.name, AttachID: attachID}
		if err := c.send(c.ctx, ack); err != nil {
			n.sendFailed(c, ack, err)
			return
		}
		if captured != "" {
			msg := &server.TerminalOutput{Type: "terminal:output", Data: captured}
			if err := c.send(c.ctx, msg); err != nil {
				n.sendFailed(c, msg, err)
				return
			}
		}
	case readyEnded:
		// The pty ended before ready. Wait tells how.
	}

	out := b.Output()
	for done := false; !done; {
		select {
		case data, ok := <-out:
			if !ok {
				done = true
				break
			}
			if a.stopped() {
				return
			}
			msg := &server.TerminalOutput{Type: "terminal:output", Data: data}
			if err := c.send(c.ctx, msg); err != nil {
				n.sendFailed(c, msg, err)
				return
			}
		case <-a.stop:
			return
		case <-c.ctx.Done():
			return
		}
	}

	res := b.Wait()
	if res.Detached {
		return
	}
	// The current name, not a.name: a rename while attached moves the
	// connection along, and the browser knows the session by its new name.
	name, ok := c.clearIf(a)
	if !ok {
		return
	}
	var msg server.Message
	if res.SpawnErr != nil {
		msg = errorMsg(CodePtySpawnFailed, res.SpawnErr.Error())
	} else {
		code := float64(res.ExitCode)
		msg = &server.SessionExited{Type: "session:exited", Name: name, ExitCode: &code}
	}
	if err := c.send(c.ctx, msg); err != nil {
		n.sendFailed(c, msg, err)
	}
}

type readyResult int

const (
	readyFired readyResult = iota
	readyEnded
	readyStop
)

// waitReady is Bridge.AwaitReady that also gives up on teardown and on
// connection close. Ready always fires before Done closes, so after Done
// one more look at Ready is final.
func waitReady(ctx context.Context, a *attachment, b Bridge) readyResult {
	select {
	case <-b.Ready():
		return readyFired
	case <-b.Done():
		select {
		case <-b.Ready():
			return readyFired
		default:
			return readyEnded
		}
	case <-a.stop:
		return readyStop
	case <-ctx.Done():
		return readyStop
	}
}

func (n *Node) sendFailed(c *conn, msg server.Message, err error) {
	if c.ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return
	}
	n.log.Debug("pty message not delivered", "conn", c.id, "type", msg.WireType(), "error", err)
}

// write types s into the attached pty. It blocks while tmux does not read
// its input. Close ends the bridge, which ends the write.
func (n *Node) write(ctx context.Context, c *conn, s string, required bool) error {
	b := c.bridge()
	if b == nil {
		if required {
			return c.send(ctx, notAttached())
		}
		return nil
	}
	if _, err := b.WriteString(s); err != nil {
		return n.ptyFailed(c, err, "write to terminal")
	}
	return nil
}

func (n *Node) resize(ctx context.Context, c *conn, m *client.TerminalResize) error {
	b, ok := c.resizeTarget(m.Size)
	if !ok {
		return c.send(ctx, notAttached())
	}
	if b == nil {
		// No change. Every resize is a SIGWINCH, and tmux redraws every
		// attached client for it.
		return nil
	}
	if err := b.Resize(m.Size.Cols, m.Size.Rows); err != nil {
		return n.ptyFailed(c, err, "resize terminal")
	}
	return nil
}

// ptyFailed sorts a failed pty write or resize. A pty that ended under the
// call is no news: the pump reports the end as session:exited, and
// node-pty swallowed the same error. Anything else is a handler error.
// While the connection closes the error goes back as is, and the hub
// drops it.
func (n *Node) ptyFailed(c *conn, err error, what string) error {
	if c.ctx.Err() == nil && (errors.Is(err, os.ErrClosed) || errors.Is(err, syscall.EIO)) {
		n.log.Debug("pty gone", "conn", c.id, "op", what, "error", err)
		return nil
	}
	return wrapf(err, what)
}
