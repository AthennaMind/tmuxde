package tmux

import (
	"context"
	"fmt"
	"strings"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
)

// ListWindows lists the windows of a session.
func (c *Client) ListWindows(ctx context.Context, session string) ([]protocol.WindowInfo, error) {
	t, err := sessionTarget(session)
	if err != nil {
		return nil, err
	}
	out, err := c.run(ctx, "list-windows", "-t", t, "-F", windowFormat)
	if err != nil {
		c.listFailed(ctx, "list windows failed", err, "session", session)
		return nil, err
	}
	return parseWindows(out), nil
}

// CurrentWindowID returns the id of the window the session shows.
//
// tmux is asked directly. pane_active in a pane listing is per window, so a
// session with N windows has N active panes, and taking the first one
// always answered for window 1.
//
// display-message prints empty fields with exit 0 when the target does not
// resolve. An empty answer is reported as ErrNotFound.
func (c *Client) CurrentWindowID(ctx context.Context, session string) (string, error) {
	t, err := currentTarget(session)
	if err != nil {
		return "", err
	}
	out, err := c.run(ctx, "display-message", "-p", "-t", t, windowIDFormat)
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(out)
	if id == "" {
		return "", fmt.Errorf("%w: can't find session: %s", ErrNotFound, session)
	}
	return id, nil
}

// StepWindow moves to the next window when delta >= 0, else the previous
// one. tmux wraps around.
func (c *Client) StepWindow(ctx context.Context, session string, delta int) error {
	t, err := sessionTarget(session)
	if err != nil {
		return err
	}
	cmd := "next-window"
	if delta < 0 {
		cmd = "previous-window"
	}
	if _, err := c.run(ctx, cmd, "-t", t); err != nil {
		return err
	}
	c.log.Info("stepped window", "session", session, "delta", delta)
	return nil
}

// CreateWindow opens a window in a session. It starts in Options.Dir and
// runs DefaultShell, or with no DefaultShell whatever the tmux
// default-command and default-shell options say. Empty name lets tmux
// name it.
func (c *Client) CreateWindow(ctx context.Context, session, name string) error {
	t, err := currentTarget(session)
	if err != nil {
		return err
	}
	args := []string{"new-window", "-t", t}
	if name != "" {
		args = append(args, "-n", name)
	}
	if c.opts.DefaultShell != "" {
		// "--" so a command that starts with "-" is not read as a flag.
		args = append(args, "--", c.opts.DefaultShell)
	}
	if _, err := c.run(ctx, args...); err != nil {
		return err
	}
	c.log.Info("created window", "session", session, "name", name)
	return nil
}

// SelectWindow focuses a window by id.
func (c *Client) SelectWindow(ctx context.Context, windowID string) error {
	if err := checkWindowID(windowID); err != nil {
		return err
	}
	if _, err := c.run(ctx, "select-window", "-t", windowID); err != nil {
		return err
	}
	c.log.Info("selected window", "window", windowID)
	return nil
}

// KillWindow kills a window by id.
func (c *Client) KillWindow(ctx context.Context, windowID string) error {
	if err := checkWindowID(windowID); err != nil {
		return err
	}
	if _, err := c.run(ctx, "kill-window", "-t", windowID); err != nil {
		return err
	}
	c.log.Info("killed window", "window", windowID)
	return nil
}

// RenameWindow renames a window by id.
func (c *Client) RenameWindow(ctx context.Context, windowID, name string) error {
	if err := checkWindowID(windowID); err != nil {
		return err
	}
	// "--" so a name that starts with "-" is not read as a flag.
	if _, err := c.run(ctx, "rename-window", "-t", windowID, "--", name); err != nil {
		return err
	}
	c.log.Info("renamed window", "window", windowID, "name", name)
	return nil
}

// SelectLayout applies a layout preset to the current window of a session.
// preset is one of client.LayoutPresets.
func (c *Client) SelectLayout(ctx context.Context, session, preset string) error {
	t, err := currentTarget(session)
	if err != nil {
		return err
	}
	if err := checkOneOf("layout", preset, client.LayoutPresets); err != nil {
		return err
	}
	if _, err := c.run(ctx, "select-layout", "-t", t, preset); err != nil {
		return err
	}
	c.log.Info("selected layout", "session", session, "preset", preset)
	return nil
}

// RotateLayout rotates the panes of the current window of a session.
func (c *Client) RotateLayout(ctx context.Context, session string) error {
	t, err := currentTarget(session)
	if err != nil {
		return err
	}
	if _, err := c.run(ctx, "rotate-window", "-t", t); err != nil {
		return err
	}
	c.log.Info("rotated layout", "session", session)
	return nil
}
