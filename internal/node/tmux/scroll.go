package tmux

import (
	"context"
	"fmt"
	"strconv"
	"unicode/utf8"
)

// maxScrollRepeat caps one application scroll. A trackpad flick is several
// hundred lines.
const maxScrollRepeat = 500

// Mouse wheel buttons in xterm mouse reports.
const (
	wheelUp   = 64
	wheelDown = 65
)

// Legacy mouse reports add 32 to each coordinate and fit it in one byte, or
// in one UTF-8 character with mode 1005.
const (
	legacyLimit = 223
	utf8Limit   = 2015
)

// ScrollState is where the active pane of a session sits in its history,
// and which input modes the program in it asked for, read from one
// display-message snapshot.
type ScrollState struct {
	// Pane is the pane id, or the target asked for when tmux printed none.
	Pane string
	// InMode is true while the pane is in copy mode or another mode.
	InMode bool
	// Position is tmux scroll_position: lines above the live output. tmux
	// keeps the last value outside copy mode, so callers that report it
	// use 0 unless InMode.
	Position int
	// HistorySize is the number of lines above the visible rows. It is 0
	// for an application, where the shell history means nothing.
	HistorySize int
	PaneHeight  int
	Width       int
	// Application is true outside a mode when the program uses the
	// alternate screen or mouse reporting. Scrolling then goes to it.
	Application bool
	// Mouse, SGR and UTF8 are the mouse reporting modes the program
	// enabled: any mode, 1006 and 1005.
	Mouse, SGR, UTF8 bool
}

// ReadScrollState reads the scroll state of the active pane of a session.
func (c *Client) ReadScrollState(ctx context.Context, session string) (ScrollState, error) {
	t, err := currentTarget(session)
	if err != nil {
		return ScrollState{}, err
	}
	return c.readScroll(ctx, t)
}

func (c *Client) readScroll(ctx context.Context, target string) (ScrollState, error) {
	out, err := c.run(ctx, "display-message", "-p", "-t", target, scrollFormat)
	if err != nil {
		return ScrollState{}, err
	}
	return parseScrollState(out, target), nil
}

// ScrollHistory scrolls the active pane of a session by lines, positive
// up. An application gets mouse wheel events or arrow keys. Anything else
// scrolls tmux history in copy mode. Explicit copy mode keeps scrolling
// history until the user leaves it. It returns the state after the move.
func (c *Client) ScrollHistory(ctx context.Context, session string, lines int) (ScrollState, error) {
	t, err := currentTarget(session)
	if err != nil {
		return ScrollState{}, err
	}
	return c.scrollHistory(ctx, t, lines)
}

func (c *Client) scrollHistory(ctx context.Context, target string, lines int) (ScrollState, error) {
	if lines == 0 {
		return c.readScroll(ctx, target)
	}
	before, err := c.readScroll(ctx, target)
	if err != nil {
		return ScrollState{}, err
	}
	pane := before.Pane
	steps := lines
	if steps < 0 {
		steps = -steps
	}

	if before.Application {
		// One event repeated with -N, not copies spelled out. Every hex
		// byte is its own argument, and tmux refused the command as too
		// long somewhere under a hundred events.
		repeat := strconv.Itoa(min(steps, maxScrollRepeat))
		args := []string{"send-keys", "-t", pane, "-N", repeat}
		if before.Mouse {
			button := wheelUp
			if lines < 0 {
				button = wheelDown
			}
			// Aim inside the pane, away from status lines and input
			// footers.
			x := max(1, (before.Width+1)/2)
			y := max(1, (before.PaneHeight+1)/2)
			// Hex keeps legacy bytes above ASCII intact through tmux.
			args = append(args, "-H")
			args = append(args, hexArgs(wheelEvent(button, x, y, before.SGR, before.UTF8))...)
		} else {
			// Alternate screen without a mouse: arrow keys, as terminals
			// do.
			key := "Up"
			if lines < 0 {
				key = "Down"
			}
			args = append(args, key)
		}
		if _, err := c.run(ctx, args...); err != nil {
			return ScrollState{}, err
		}
		return c.readScroll(ctx, pane)
	}

	if !before.InMode {
		// -e leaves copy mode by itself once it scrolls back to the
		// bottom.
		if _, err := c.run(ctx, "copy-mode", "-e", "-t", pane); err != nil {
			return ScrollState{}, err
		}
	}
	cmd := "scroll-up"
	if lines < 0 {
		cmd = "scroll-down"
	}
	if _, err := c.run(ctx, "send-keys", "-t", pane, "-X", "-N", strconv.Itoa(steps), cmd); err != nil {
		return ScrollState{}, err
	}
	return c.readScroll(ctx, pane)
}

// ScrollToPosition puts the view position lines above the live output.
// The move is worked out here against what tmux reports now. A scrollbar
// drag names a destination, and output arriving during the drag would
// shift a delta the browser computed. Past the oldest line it stops at the
// top. In an application HistorySize is 0, so it does nothing.
func (c *Client) ScrollToPosition(ctx context.Context, session string, position int) (ScrollState, error) {
	t, err := currentTarget(session)
	if err != nil {
		return ScrollState{}, err
	}
	return c.scrollToPosition(ctx, t, position)
}

func (c *Client) scrollToPosition(ctx context.Context, target string, position int) (ScrollState, error) {
	st, err := c.readScroll(ctx, target)
	if err != nil {
		return ScrollState{}, err
	}
	clamped := min(max(0, position), st.HistorySize)
	from := 0
	if st.InMode {
		from = st.Position
	}
	delta := clamped - from
	if delta == 0 {
		return st, nil
	}
	return c.scrollHistory(ctx, target, delta)
}

// EnterCopyMode puts the active pane of a session in copy mode.
func (c *Client) EnterCopyMode(ctx context.Context, session string) error {
	t, err := currentTarget(session)
	if err != nil {
		return err
	}
	return c.enterCopyMode(ctx, t)
}

func (c *Client) enterCopyMode(ctx context.Context, target string) error {
	if _, err := c.run(ctx, "copy-mode", "-t", target); err != nil {
		return err
	}
	c.log.Info("entered copy mode", "target", target)
	return nil
}

// ExitCopyMode leaves copy mode, so typing reaches the pane again. Outside
// a mode it does nothing. tmux would accept the cancel anyway, but the
// check keeps a stray call out of the logs.
func (c *Client) ExitCopyMode(ctx context.Context, session string) error {
	t, err := currentTarget(session)
	if err != nil {
		return err
	}
	st, err := c.readScroll(ctx, t)
	if err != nil {
		return err
	}
	if !st.InMode {
		return nil
	}
	if _, err := c.run(ctx, "send-keys", "-t", t, "-X", "cancel"); err != nil {
		return err
	}
	c.log.Info("left copy mode", "session", session)
	return nil
}

// wheelEvent encodes one mouse wheel report at cell x, y (1 based). SGR is
// ESC [ < b ; x ; y M. The legacy form is ESC [ M and three characters,
// each value plus 32, with coordinates capped at 223. With the utf8 flag
// (mode 1005) the cap is 2015 and each character is UTF-8 encoded.
// Otherwise each is one byte.
func wheelEvent(button, x, y int, sgr, utf8Mode bool) []byte {
	if sgr {
		return fmt.Appendf(nil, "\x1b[<%d;%d;%dM", button, x, y)
	}
	limit := legacyLimit
	if utf8Mode {
		limit = utf8Limit
	}
	b := []byte("\x1b[M")
	for _, v := range []int{button + 32, min(x, limit) + 32, min(y, limit) + 32} {
		if utf8Mode {
			b = utf8.AppendRune(b, rune(v))
		} else {
			b = append(b, byte(v))
		}
	}
	return b
}

// hexArgs spells bytes for send-keys -H: lowercase hex, no padding.
func hexArgs(b []byte) []string {
	res := make([]string, len(b))
	for i, v := range b {
		res[i] = strconv.FormatUint(uint64(v), 16)
	}
	return res
}
