package tmux

import (
	"context"
	"errors"
	"strings"
	"time"

	"tmuxde/internal/protocol"
)

// ListSessions lists every session, clones included. Filtering clones is
// the caller's job. No server and no sessions give an empty slice and a nil
// error.
func (c *Client) ListSessions(ctx context.Context) ([]protocol.SessionInfo, error) {
	out, err := c.run(ctx, "list-sessions", "-F", sessionFormat)
	if err != nil {
		if noSessions(err) {
			return []protocol.SessionInfo{}, nil
		}
		c.log.Error("list sessions failed", "error", err)
		return nil, err
	}
	return parseSessions(out), nil
}

// SessionNames lists the name of every session, clones included. No
// server gives an empty slice and a nil error.
func (c *Client) SessionNames(ctx context.Context) ([]string, error) {
	out, err := c.run(ctx, "list-sessions", "-F", nameFormat)
	if err != nil {
		if noSessions(err) {
			return []string{}, nil
		}
		return nil, err
	}
	return parseNames(out), nil
}

// noSessions reports the errors ListSessions reads as an empty list.
func noSessions(err error) bool {
	if errors.Is(err, ErrNoServer) {
		return true
	}
	var ce *CommandError
	return errors.As(err, &ce) && strings.Contains(ce.Stderr, "no sessions")
}

// CreateSession starts a detached session. When no tmux server runs, it
// starts one through the launcher, see create. Empty name lets tmux pick one.
// A name checkNewSession refuses fails with ErrInvalidArgument before tmux
// runs. Empty cwd starts it in Options.Dir. Empty command runs DefaultShell,
// or with no DefaultShell whatever the tmux default-command and
// default-shell options say. The result is built here, as the relay did:
// one window, not attached, created now, no dimensions.
func (c *Client) CreateSession(ctx context.Context, name, cwd, command string) (protocol.SessionInfo, error) {
	args := []string{"new-session", "-d", "-P", "-F", createFormat}
	if name != "" {
		if err := checkNewSession(name); err != nil {
			return protocol.SessionInfo{}, err
		}
		args = append(args, "-s", name)
	}
	if cwd != "" {
		args = append(args, "-c", cwd)
	}
	if command == "" {
		command = c.opts.DefaultShell
	}
	if command != "" {
		// "--" so a command that starts with "-" is not read as a flag.
		args = append(args, "--", command)
	}
	out, err := c.create(ctx, args)
	if err != nil {
		return protocol.SessionInfo{}, err
	}
	sessionName, id := parseCreated(out)
	c.log.Info("created session", "session", sessionName)
	now := isoTime(time.Now())
	return protocol.SessionInfo{
		Name:     sessionName,
		ID:       id,
		Windows:  1,
		Attached: false,
		Created:  now,
		Activity: now,
	}, nil
}

// KillSession kills a session by exact name.
func (c *Client) KillSession(ctx context.Context, name string) error {
	t, err := sessionTarget(name)
	if err != nil {
		return err
	}
	if _, err := c.run(ctx, "kill-session", "-t", t); err != nil {
		return err
	}
	c.log.Info("killed session", "session", name)
	return nil
}

// RenameSession renames a session. tmux replaces ":" and "." in the new
// name with "_". A new name checkNewSession refuses fails with
// ErrInvalidArgument before tmux runs.
func (c *Client) RenameSession(ctx context.Context, oldName, newName string) error {
	t, err := sessionTarget(oldName)
	if err != nil {
		return err
	}
	if err := checkNewSession(newName); err != nil {
		return err
	}
	// "--" so a new name that starts with "-" is not read as a flag.
	if _, err := c.run(ctx, "rename-session", "-t", t, "--", newName); err != nil {
		return err
	}
	c.log.Info("renamed session", "oldName", oldName, "newName", newName)
	return nil
}

// SessionExists reports whether a session of exactly this name exists. Any
// failure, no server included, reads as false.
func (c *Client) SessionExists(ctx context.Context, name string) bool {
	t, err := sessionTarget(name)
	if err != nil {
		return false
	}
	_, err = c.run(ctx, "has-session", "-t", t)
	return err == nil
}

// SendPrefix sends the prefix key to the active pane of a session.
func (c *Client) SendPrefix(ctx context.Context, session string) error {
	t, err := currentTarget(session)
	if err != nil {
		return err
	}
	if _, err := c.run(ctx, "send-prefix", "-t", t); err != nil {
		return err
	}
	c.log.Info("sent prefix", "session", session)
	return nil
}

// SendInterrupt sends Ctrl+C to the active pane of a session.
func (c *Client) SendInterrupt(ctx context.Context, session string) error {
	t, err := currentTarget(session)
	if err != nil {
		return err
	}
	_, err = c.run(ctx, "send-keys", "-t", t, "C-c")
	return err
}

// SweepOrphanClones kills every clone session a previous process left
// behind and returns how many it found. A crash skips the clone teardown.
// A leftover clone holds no process, but a later name collision could
// attach to it. Listing failures, no server included, return 0.
func (c *Client) SweepOrphanClones(ctx context.Context) int {
	names, err := c.SessionNames(ctx)
	if err != nil {
		return 0
	}
	n := 0
	for _, name := range names {
		if !IsClone(name) {
			continue
		}
		n++
		t, err := sessionTarget(name)
		if err != nil {
			continue
		}
		if _, err := c.run(ctx, "kill-session", "-t", t); err != nil {
			// Already gone. Nothing left to clean up.
			c.log.Debug("clone sweep kill failed", "session", name, "error", err)
		}
	}
	if n > 0 {
		c.log.Info("swept orphaned clone sessions", "count", n)
	}
	return n
}
