package tmux

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
)

// selectPaneZ reports whether select-pane takes -Z (tmux 3.1 and later).
// -Z keeps a zoomed window zoomed across the selection. Without it the
// only way to move between panes of a zoomed window is unzoom, select,
// rezoom, which flickers and can rezoom the wrong pane.
//
// The answer is cached per Client once list-commands ran. A failed probe
// reads as false this time and is asked again next time. list-commands
// starts a server when none runs, so it is only asked lazily, by commands
// that already need a session.
func (c *Client) selectPaneZ(ctx context.Context) bool {
	c.zMu.Lock()
	defer c.zMu.Unlock()
	if c.zKnown {
		return c.zOK
	}
	out, err := c.run(ctx, "list-commands", "select-pane")
	if err != nil {
		c.log.Debug("select-pane -Z probe failed", "error", err)
		return false
	}
	c.zKnown, c.zOK = true, hasZFlag(out)
	return c.zOK
}

func (c *Client) selectPaneArgs(ctx context.Context, target string) []string {
	args := []string{"select-pane"}
	if c.selectPaneZ(ctx) {
		args = append(args, "-Z")
	}
	return append(args, "-t", target)
}

// StepPane moves to the next pane of the current window when delta >= 0,
// else the previous one. ":.+" and ":.-" are tmux's own relative targets,
// so a pane list the browser fetched a moment ago cannot make it miss.
func (c *Client) StepPane(ctx context.Context, session string, delta int) error {
	t, err := currentTarget(session)
	if err != nil {
		return err
	}
	if delta >= 0 {
		t += ".+"
	} else {
		t += ".-"
	}
	if _, err := c.run(ctx, c.selectPaneArgs(ctx, t)...); err != nil {
		return err
	}
	c.log.Info("stepped pane", "session", session, "delta", delta)
	return nil
}

// ListPanes lists the panes of one window of a session. windowID "" lists
// every window of the session with -s. pane_active is per window, so that
// listing has one active pane per window.
//
// list-panes takes a window target even with -s, so the session goes as
// "=name:". A bare "=name" is first read as a window name or index in the
// current session, and "=0" would list the panes of another session.
func (c *Client) ListPanes(ctx context.Context, session, windowID string) ([]protocol.PaneInfo, error) {
	t, err := currentTarget(session)
	if err != nil {
		return nil, err
	}
	args := []string{"list-panes"}
	if windowID != "" {
		if err := checkWindowID(windowID); err != nil {
			return nil, err
		}
		args = append(args, "-t", t+windowID)
	} else {
		args = append(args, "-s", "-t", t)
	}
	args = append(args, "-F", paneFormat)
	out, err := c.run(ctx, args...)
	if err != nil {
		c.listFailed(ctx, "list panes failed", err, "session", session, "window", windowID)
		return nil, err
	}
	return parsePanes(out), nil
}

// CurrentWindowPanes returns the window the session shows and its panes.
func (c *Client) CurrentWindowPanes(ctx context.Context, session string) (string, []protocol.PaneInfo, error) {
	windowID, err := c.CurrentWindowID(ctx, session)
	if err != nil {
		return "", nil, err
	}
	panes, err := c.ListPanes(ctx, session, windowID)
	if err != nil {
		return "", nil, err
	}
	return windowID, panes, nil
}

// SplitPane splits the active pane of a session. direction is "h" for a
// pane beside it or "v" for one below, as in client.PaneSplit. The new
// pane starts in the folder of the pane it splits. tmux expands the format
// against the target pane and falls back to its default folder when that
// one was deleted.
func (c *Client) SplitPane(ctx context.Context, session, direction string) error {
	t, err := currentTarget(session)
	if err != nil {
		return err
	}
	if err := checkOneOf("direction", direction, client.SplitDirections); err != nil {
		return err
	}
	if _, err := c.run(ctx, "split-window", "-t", t, "-"+direction, "-c", "#{pane_current_path}"); err != nil {
		return err
	}
	c.log.Info("split pane", "session", session, "direction", direction)
	return nil
}

// SelectPane focuses a pane. With a session it also shows the pane's
// window in that session. session "" only focuses the pane inside its own
// window.
//
// select-pane alone never changes the current window of a session. A pane
// in a window off screen became that window's active pane while the screen
// stayed, and the next split landed in the window on screen. The window is
// selected through the session, so a window linked into several sessions
// moves in this one.
func (c *Client) SelectPane(ctx context.Context, session, paneID string) error {
	if err := checkPaneID(paneID); err != nil {
		return err
	}
	if session != "" {
		t, err := currentTarget(session)
		if err != nil {
			return err
		}
		out, err := c.run(ctx, "display-message", "-p", "-t", paneID, windowIDFormat)
		if err != nil {
			return err
		}
		// Empty means the pane is gone. select-pane below says so.
		if windowID := strings.TrimSpace(out); windowID != "" {
			if _, err := c.run(ctx, "select-window", "-t", t+windowID); err != nil {
				return err
			}
		}
	}
	// -Z keeps the window zoomed if it was zoomed. It never zooms a window
	// that was not.
	if _, err := c.run(ctx, c.selectPaneArgs(ctx, paneID)...); err != nil {
		return err
	}
	c.log.Info("selected pane", "pane", paneID)
	return nil
}

// ZoomPane zooms a pane or unzooms its window, idempotently.
//
// paneID "" targets the active pane of the session. desired nil toggles,
// for a client that predates the field. Otherwise the state is read first
// and a command runs only when it would change something. resize-pane -Z
// is a toggle, and two taps that arrive before the layout announcement
// would leave the opposite of what was asked.
//
// Each branch is a state tmux can be in:
//
//   - not zoomed, want zoomed: resize-pane -Z, which also activates it
//   - zoomed on another pane: select-pane -Z, which moves the zoom
//   - zoomed, want it gone: resize-pane -Z again
//
// A toggle cannot express the middle one. It would unzoom the window.
func (c *Client) ZoomPane(ctx context.Context, session, paneID string, desired *bool) error {
	var target string
	if paneID != "" {
		if err := checkPaneID(paneID); err != nil {
			return err
		}
		target = paneID
	} else {
		t, err := currentTarget(session)
		if err != nil {
			return err
		}
		target = t
	}

	if desired == nil {
		if _, err := c.run(ctx, "resize-pane", "-t", target, "-Z"); err != nil {
			return err
		}
		c.log.Info("toggled pane zoom", "session", session, "target", target)
		return nil
	}

	out, err := c.run(ctx, "display-message", "-p", "-t", target, zoomFormat)
	if err != nil {
		return err
	}
	windowZoomed, paneZoomed := parseZoom(out)
	if *desired == paneZoomed {
		c.log.Debug("pane zoom already as asked", "session", session, "target", target)
		return nil
	}
	args := []string{"resize-pane", "-t", target, "-Z"}
	if *desired && windowZoomed {
		args = []string{"select-pane", "-Z", "-t", target}
	}
	if _, err := c.run(ctx, args...); err != nil {
		return err
	}
	c.log.Info("set pane zoom", "session", session, "target", target, "zoomed", *desired)
	return nil
}

// ResizePane grows a pane by amount cells toward direction, one of
// client.PaneDirections.
func (c *Client) ResizePane(ctx context.Context, paneID, direction string, amount int) error {
	if err := checkPaneID(paneID); err != nil {
		return err
	}
	if err := checkOneOf("direction", direction, client.PaneDirections); err != nil {
		return err
	}
	if amount < 1 {
		return fmt.Errorf("%w: amount %d", ErrInvalidArgument, amount)
	}
	if _, err := c.run(ctx, "resize-pane", "-t", paneID, "-"+direction, strconv.Itoa(amount)); err != nil {
		return err
	}
	c.log.Info("resized pane", "pane", paneID, "direction", direction, "amount", amount)
	return nil
}

// KillPane kills a pane by id.
func (c *Client) KillPane(ctx context.Context, paneID string) error {
	if err := checkPaneID(paneID); err != nil {
		return err
	}
	if _, err := c.run(ctx, "kill-pane", "-t", paneID); err != nil {
		return err
	}
	c.log.Info("killed pane", "pane", paneID)
	return nil
}

// SwapPane swaps a pane with its neighbour toward direction. Some tmux
// versions only take U and D. Their error comes back as it is.
func (c *Client) SwapPane(ctx context.Context, paneID, direction string) error {
	if err := checkPaneID(paneID); err != nil {
		return err
	}
	if err := checkOneOf("direction", direction, client.PaneDirections); err != nil {
		return err
	}
	if _, err := c.run(ctx, "swap-pane", "-t", paneID, "-"+direction); err != nil {
		return err
	}
	c.log.Info("swapped pane", "pane", paneID, "direction", direction)
	return nil
}

// SwapPanes swaps two panes by id. They may sit in different windows. Each
// window keeps its layout and takes the other pane in its place. As tmux
// does by default, each window activates the pane it received. In one
// window that is targetID, now where paneID was.
func (c *Client) SwapPanes(ctx context.Context, paneID, targetID string) error {
	if err := checkPaneID(paneID); err != nil {
		return err
	}
	if err := checkPaneID(targetID); err != nil {
		return err
	}
	if _, err := c.run(ctx, "swap-pane", "-s", paneID, "-t", targetID); err != nil {
		return err
	}
	c.log.Info("swapped panes", "pane", paneID, "target", targetID)
	return nil
}

// JoinPane moves a pane into a window. It splits the active pane of the
// window, beside it for "h" and below it for "v", as in client.PaneJoin.
// The moved pane becomes active and its window becomes the current window
// of the session. A window left without panes closes.
func (c *Client) JoinPane(ctx context.Context, paneID, windowID, direction string) error {
	if err := checkPaneID(paneID); err != nil {
		return err
	}
	if err := checkWindowID(windowID); err != nil {
		return err
	}
	if err := checkOneOf("direction", direction, client.SplitDirections); err != nil {
		return err
	}
	if _, err := c.run(ctx, "join-pane", "-s", paneID, "-t", windowID, "-"+direction); err != nil {
		return err
	}
	c.log.Info("joined pane", "pane", paneID, "window", windowID, "direction", direction)
	return nil
}

// BreakPane moves a pane out into a new window of session, at the first
// free index. The new window becomes current.
//
// The target names the session. Without it tmux picks the destination
// from its own idea of the current session, which for a command from
// outside tmux can be another session.
func (c *Client) BreakPane(ctx context.Context, session, paneID string) error {
	t, err := currentTarget(session)
	if err != nil {
		return err
	}
	if err := checkPaneID(paneID); err != nil {
		return err
	}
	if _, err := c.run(ctx, "break-pane", "-s", paneID, "-t", t); err != nil {
		return err
	}
	c.log.Info("broke pane out", "session", session, "pane", paneID)
	return nil
}

// CaptureOptions bounds a capture.
type CaptureOptions struct {
	// Lines of history above the visible pane. Zero or less means 2000.
	Lines int
	// Escapes keeps SGR sequences, so colours survive a replay into the
	// terminal. Plain text consumers leave it off.
	Escapes bool
}

// CapturePane captures the active pane of a session: the visible rows plus
// opts.Lines of history. The attach replay passes Escapes true.
func (c *Client) CapturePane(ctx context.Context, session string, opts CaptureOptions) (string, error) {
	t, err := currentTarget(session)
	if err != nil {
		return "", err
	}
	return c.capture(ctx, t, opts)
}

// CapturePaneByID captures one pane by id, for the copy mode overlay.
func (c *Client) CapturePaneByID(ctx context.Context, paneID string, opts CaptureOptions) (string, error) {
	if err := checkPaneID(paneID); err != nil {
		return "", err
	}
	return c.capture(ctx, paneID, opts)
}

// capture runs capture-pane with -S bounding the history. A capture of the
// whole history on a host with a big history-limit once reached 32 MB and
// aborted the attach. -S keeps it small, and MaxOutput cuts what is left.
// A cut capture ends at its last full line, so the replay never stops
// inside an escape sequence or a UTF-8 character.
func (c *Client) capture(ctx context.Context, target string, opts CaptureOptions) (string, error) {
	n := opts.Lines
	if n <= 0 {
		n = defaultCaptureLines
	}
	args := []string{"capture-pane", "-t", target, "-p"}
	if opts.Escapes {
		args = append(args, "-e")
	}
	args = append(args, "-S", "-"+strconv.Itoa(n))
	out, cut, err := c.exec(ctx, c.withSocket(args))
	if err != nil {
		return "", err
	}
	if cut {
		if i := strings.LastIndexByte(out, '\n'); i >= 0 {
			out = out[:i+1]
		}
	}
	return out, nil
}
