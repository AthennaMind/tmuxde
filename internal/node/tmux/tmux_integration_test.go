//go:build integration

package tmux

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"tmuxde/internal/protocol"
)

// Integration tests against a real tmux on a private socket, ported from
// the relay's tmux-manager.test.ts. The claims are about what tmux argv and
// format strings really do on the tmux that ships, which a mock cannot be
// wrong about in an interesting way.

const (
	captureSession = "relay-capture-fixture"
	splitSession   = "relay-split-fixture"
	windowSession  = "relay-window-fixture"
	// About 1.45 MiB, comfortably over the 1 MiB that broke the relay.
	lineCount = 12_000
	marker    = "COLOURED-MARKER"
	// esc starts every SGR sequence.
	esc = "\x1b"
)

// fixture is a tmux server on its own socket in a temp dir. Tests never
// talk to the default server.
type fixture struct {
	base, sock, conf string
	c                *Client
	env              []string
	apps             int
}

func needTmux(t *testing.T) {
	t.Helper()
	if err := exec.Command("tmux", "-V").Run(); err != nil {
		t.Fatalf("tmux -V failed: %v", err)
	}
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	needTmux(t)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{
		base: base,
		sock: filepath.Join(base, "sock"),
		conf: filepath.Join(base, "tmux.conf"),
		env:  commandEnv(os.Environ()),
	}
	// history-limit must be raised when the pane starts writing, so it
	// goes in the config the server boots with.
	if err := os.WriteFile(f.conf, []byte("set -g history-limit 200000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = f.try("kill-server") })
	f.c = New(Options{Socket: f.sock, Logger: quiet})
	return f
}

// tmux runs a fixture command and returns stdout. No output cap here.
func (f *fixture) tmux(t *testing.T, args ...string) string {
	t.Helper()
	out, err := f.try(args...)
	if err != nil {
		t.Fatalf("tmux %q: %v", args, err)
	}
	return out
}

func (f *fixture) try(args ...string) (string, error) {
	cmd := exec.Command("tmux", append([]string{"-f", f.conf, "-S", f.sock}, args...)...)
	cmd.Env = f.env
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return string(out), fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return string(out), nil
}

// startCaptureFixture fills a 200x50 pane with lineCount lines of 120 x,
// then a red marker, and waits for the marker. The script is the session's
// own command, not keys sent into a shell: no prompt to race, and no echo
// of the script text that would match the marker before it ran.
func (f *fixture) startCaptureFixture(t *testing.T) {
	t.Helper()
	script := filepath.Join(f.base, "fixture.sh")
	body := fmt.Sprintf("i=0\nwhile [ \"$i\" -lt %d ]; do\n  echo %s\n  i=$((i + 1))\ndone\n"+
		"printf '\\033[31m%s\\033[0m\\n'\nsleep 600\n", lineCount, strings.Repeat("x", 120), marker)
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	f.tmux(t, "new-session", "-d", "-s", captureSession, "-x", "200", "-y", "50", "sh "+script)
	poll(t, "capture fixture marker", 60*time.Second, 100*time.Millisecond, func() (bool, string) {
		tail, err := f.try("capture-pane", "-t", "="+captureSession+":", "-p", "-S", "-5")
		return err == nil && strings.Contains(tail, marker), tail
	})
}

// poll calls ok until it reports true or the deadline passes.
func poll(t *testing.T, what string, timeout, every time.Duration, ok func() (bool, string)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		done, last := ok()
		if done {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: not reached within %v, last %q", what, timeout, last)
		}
		time.Sleep(every)
	}
}

// must is called as must(call())(t). Go cannot pass t next to a call that
// returns two values.
func must[T any](v T, err error) func(*testing.T) T {
	return func(t *testing.T) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
}

func lineCountOf(s string) int { return strings.Count(s, "\n") + 1 }

func TestIntegrationTmux(t *testing.T) {
	f := newFixture(t)
	f.startCaptureFixture(t)

	t.Run("capturePane", f.testCapturePane)
	t.Run("capturePaneById", f.testCapturePaneByID)
	t.Run("scrollHistory", f.testScrollHistory)
	t.Run("splitPane", f.testSplitPane)
	t.Run("windows and panes", f.testWindowsAndPanes)
	t.Run("application scrolling", f.testApplicationScrolling)
	t.Run("sessions", f.testSessions)
	t.Run("layout and pane commands", f.testLayoutAndPaneCommands)
	t.Run("pane moves", f.testPaneMoves)
	t.Run("resize border owner", f.testResizeOwner)
}

func (f *fixture) testCapturePane(t *testing.T) {
	c := f.c
	t.Run("has a fixture that would overrun the default 1 MiB maxBuffer", func(t *testing.T) {
		full := f.tmux(t, "capture-pane", "-t", "="+captureSession+":", "-p", "-S", "-")
		if len(full) <= 1<<20 {
			t.Fatalf("full capture is %d bytes, want over 1 MiB", len(full))
		}
	})

	t.Run("returns bounded output instead of throwing", func(t *testing.T) {
		out := must(c.CapturePane(bg, captureSession, CaptureOptions{Escapes: true}))(t)
		if len(out) >= 1<<20 {
			t.Fatalf("capture is %d bytes", len(out))
		}
		// -S -2000 means 2000 lines above the visible pane: the bound plus
		// one pane height, never the whole history.
		if n := lineCountOf(out); n <= 2000 || n >= lineCount/2 {
			t.Fatalf("capture has %d lines, want between 2000 and %d", n, lineCount/2)
		}
	})

	t.Run("honours an explicit line bound", func(t *testing.T) {
		bounded := must(c.CapturePane(bg, captureSession, CaptureOptions{Lines: 10, Escapes: true}))(t)
		dflt := must(c.CapturePane(bg, captureSession, CaptureOptions{Escapes: true}))(t)
		if lineCountOf(bounded) >= lineCountOf(dflt) {
			t.Fatalf("bounded %d lines, default %d", lineCountOf(bounded), lineCountOf(dflt))
		}
		if n := lineCountOf(bounded); n >= 200 {
			t.Fatalf("bounded capture has %d lines", n)
		}
	})

	// The relay defaulted to escapes for capturePane. The Go caller asks
	// for them, as the attach replay does.
	t.Run("keeps SGR escapes when asked so colours survive the replay", func(t *testing.T) {
		out := must(c.CapturePane(bg, captureSession, CaptureOptions{Lines: 5, Escapes: true}))(t)
		if !strings.Contains(out, marker) || !strings.Contains(out, esc) {
			t.Fatalf("capture lacks the marker or escapes: %q", out)
		}
	})

	t.Run("can omit escapes for plain-text consumers", func(t *testing.T) {
		out := must(c.CapturePane(bg, captureSession, CaptureOptions{Lines: 5}))(t)
		if !strings.Contains(out, marker) {
			t.Fatalf("capture lacks the marker: %q", out)
		}
		if strings.Contains(out, esc) {
			t.Fatalf("capture has escapes: %q", out)
		}
	})

	t.Run("cuts output at MaxOutput instead of failing", func(t *testing.T) {
		small := New(Options{Socket: f.sock, MaxOutput: 64 << 10, Logger: quiet})
		out := must(small.CapturePane(bg, captureSession, CaptureOptions{Escapes: true}))(t)
		if len(out) == 0 || len(out) > 64<<10 {
			t.Fatalf("capture is %d bytes, want 1 to %d", len(out), 64<<10)
		}
		if !strings.HasSuffix(out, "\n") {
			t.Fatalf("cut capture does not end at a line: %q", out[max(0, len(out)-40):])
		}
	})
}

func (f *fixture) testCapturePaneByID(t *testing.T) {
	t.Run("is bounded and plain-text by default (copy-mode overlay)", func(t *testing.T) {
		paneID := strings.TrimSpace(f.tmux(t, "list-panes", "-t", "="+captureSession+":", "-F", "#{pane_id}"))
		out := must(f.c.CapturePaneByID(bg, paneID, CaptureOptions{}))(t)
		if len(out) >= 1<<20 {
			t.Fatalf("capture is %d bytes", len(out))
		}
		if strings.Contains(out, esc) {
			t.Fatal("capture has escapes")
		}
		if !strings.Contains(out, marker) {
			t.Fatal("capture lacks the marker")
		}
	})
}

// Scrolling is a tmux operation, not a browser one. tmux holds the
// alternate screen of the attached client, so the browser scrollback is
// always empty. The history lives in tmux and copy mode is the only door
// to it.
func (f *fixture) testScrollHistory(t *testing.T) {
	c := f.c
	// scrollPosition is where copy mode looks, in lines above the live
	// output.
	scrollPosition := func(t *testing.T) int {
		t.Helper()
		raw := strings.TrimSpace(f.tmux(t, "display-message", "-p", "-t", "="+captureSession+":", "#{scroll_position}"))
		if raw == "" {
			return 0
		}
		return must(strconv.Atoi(raw))(t)
	}
	inCopyMode := func(t *testing.T) bool {
		t.Helper()
		return must(c.ReadScrollState(bg, captureSession))(t).InMode
	}
	run := func(name string, fn func(t *testing.T)) {
		t.Run(name, func(t *testing.T) {
			t.Cleanup(func() {
				if err := c.ExitCopyMode(bg, captureSession); err != nil {
					t.Errorf("ExitCopyMode: %v", err)
				}
			})
			fn(t)
		})
	}
	scroll := func(t *testing.T, lines int) ScrollState {
		t.Helper()
		return must(c.ScrollHistory(bg, captureSession, lines))(t)
	}
	scrollTo := func(t *testing.T, pos int) ScrollState {
		t.Helper()
		return must(c.ScrollToPosition(bg, captureSession, pos))(t)
	}

	run("enters copy mode by itself and moves back through history", func(t *testing.T) {
		if inCopyMode(t) {
			t.Fatal("in copy mode before the scroll")
		}
		scroll(t, 5)
		if !inCopyMode(t) {
			t.Fatal("not in copy mode after the scroll")
		}
		if got := scrollPosition(t); got != 5 {
			t.Fatalf("position %d, want 5", got)
		}
	})

	run("accumulates across the several messages one drag produces", func(t *testing.T) {
		scroll(t, 5)
		scroll(t, 7)
		// Entering copy mode again on the second call would reset it to 7.
		if got := scrollPosition(t); got != 12 {
			t.Fatalf("position %d, want 12", got)
		}
	})

	run("scrolls forward again on a negative count", func(t *testing.T) {
		scroll(t, 20)
		scroll(t, -8)
		if got := scrollPosition(t); got != 12 {
			t.Fatalf("position %d, want 12", got)
		}
	})

	run("clamps at the top of the history rather than failing", func(t *testing.T) {
		scroll(t, 500)
		scroll(t, 500)
		if got := scrollPosition(t); got <= 0 {
			t.Fatalf("position %d, want above 0", got)
		}
		if !inCopyMode(t) {
			t.Fatal("left copy mode")
		}
	})

	run("does nothing at all for a zero count", func(t *testing.T) {
		scroll(t, 0)
		if inCopyMode(t) {
			t.Fatal("entered copy mode")
		}
	})

	run("leaves copy mode on request, so typing works again", func(t *testing.T) {
		scroll(t, 10)
		if err := c.ExitCopyMode(bg, captureSession); err != nil {
			t.Fatal(err)
		}
		if inCopyMode(t) {
			t.Fatal("still in copy mode")
		}
	})

	run("is a no-op when asked to leave copy mode it is not in", func(t *testing.T) {
		if err := c.ExitCopyMode(bg, captureSession); err != nil {
			t.Fatal(err)
		}
	})

	run("returns the position it reached, which is what the scrollbar draws", func(t *testing.T) {
		st := scroll(t, 9)
		if st.Position != 9 || !st.InMode {
			t.Fatalf("state %+v, want position 9 in mode", st)
		}
		if st.HistorySize <= 0 || st.PaneHeight <= 0 {
			t.Fatalf("state %+v, want history and height", st)
		}
	})

	run("reports a pane outside copy mode as being at the bottom", func(t *testing.T) {
		st := must(c.ReadScrollState(bg, captureSession))(t)
		if st.InMode || st.Position != 0 {
			t.Fatalf("state %+v, want bottom outside copy mode", st)
		}
		// The history is still there. The view is at its live end.
		if st.HistorySize <= 0 {
			t.Fatalf("state %+v, want history", st)
		}
	})

	run("jumps to an absolute position from anywhere, in either direction", func(t *testing.T) {
		scrollTo(t, 30)
		if got := scrollPosition(t); got != 30 {
			t.Fatalf("position %d, want 30", got)
		}
		// Down as well as up: a thumb drag names a destination.
		scrollTo(t, 4)
		if got := scrollPosition(t); got != 4 {
			t.Fatalf("position %d, want 4", got)
		}
	})

	run("takes a jump to 0 back to the live output", func(t *testing.T) {
		scrollTo(t, 25)
		st := scrollTo(t, 0)
		// copy-mode -e leaves by itself at the bottom, which is what a
		// scrollbar dragged to the end should do.
		if st.Position != 0 {
			t.Fatalf("state %+v, want position 0", st)
		}
		if inCopyMode(t) {
			t.Fatal("still in copy mode")
		}
	})

	run("clamps a jump past the oldest line to the top of the history", func(t *testing.T) {
		hist := must(c.ReadScrollState(bg, captureSession))(t).HistorySize
		st := scrollTo(t, hist+5_000)
		if st.Position <= 0 || st.Position > hist {
			t.Fatalf("position %d, want 1 to %d", st.Position, hist)
		}
	})
}

func (f *fixture) testSplitPane(t *testing.T) {
	folder := filepath.Join(f.base, "split-here")
	if err := os.Mkdir(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	f.tmux(t, "new-session", "-d", "-s", splitSession, "-c", folder, "sleep 600")
	t.Cleanup(func() { _, _ = f.try("kill-session", "-t", "="+splitSession) })

	t.Run("starts the new pane in the folder of the pane it splits", func(t *testing.T) {
		if err := f.c.SplitPane(bg, splitSession, "h"); err != nil {
			t.Fatal(err)
		}
		panes := must(f.c.ListPanes(bg, splitSession, ""))(t)
		if len(panes) != 2 {
			t.Fatalf("%d panes, want 2", len(panes))
		}
		for _, p := range panes {
			if p.Path == nil || *p.Path != folder {
				t.Fatalf("pane %s path %v, want %q", p.ID, p.Path, folder)
			}
		}
	})
}

// pane_active and window_zoomed_flag both belong to a WINDOW. Read from an
// unscoped list-panes -s they give one active pane per window and mark
// every pane of a zoomed window as zoomed. That made the browser highlight
// one window while it showed another.
func (f *fixture) testWindowsAndPanes(t *testing.T) {
	c := f.c
	const s = windowSession
	f.tmux(t, "new-session", "-d", "-s", s, "-x", "200", "-y", "50")
	f.tmux(t, "new-window", "-t", "="+s+":")
	f.tmux(t, "new-window", "-t", "="+s+":")
	// Split the last window three ways.
	f.tmux(t, "split-window", "-t", "="+s+":")
	f.tmux(t, "split-window", "-t", "="+s+":")
	t.Cleanup(func() { _, _ = f.try("kill-session", "-t", "="+s) })

	yes, no := true, false
	currentWindow := func(t *testing.T) string {
		t.Helper()
		return must(c.CurrentWindowID(bg, s))(t)
	}
	activeIn := func(panes []protocol.PaneInfo) []protocol.PaneInfo {
		var res []protocol.PaneInfo
		for _, p := range panes {
			if p.Active {
				res = append(res, p)
			}
		}
		return res
	}
	zoomedIn := func(panes []protocol.PaneInfo) []protocol.PaneInfo {
		var res []protocol.PaneInfo
		for _, p := range panes {
			if p.Zoomed {
				res = append(res, p)
			}
		}
		return res
	}

	// Zoom against real tmux. The bug pinned: pane:zoom was a bare toggle,
	// two presses before the layout announcement applied twice, and it
	// hit the current pane of the session instead of the one tapped.
	t.Run("zoom", func(t *testing.T) {
		// splitPanes finds the split window by counting. Two of the three
		// windows hold one pane, and tmux will not zoom those, so every
		// zoom command there would be a silent no-op.
		splitPanes := func(t *testing.T) []protocol.PaneInfo {
			t.Helper()
			all := must(c.ListPanes(bg, s, ""))(t)
			counts := map[string]int{}
			for _, p := range all {
				counts[p.WindowID]++
			}
			var res []protocol.PaneInfo
			for _, p := range all {
				if counts[p.WindowID] > 1 {
					if len(res) > 0 && res[0].WindowID != p.WindowID {
						break
					}
					res = append(res, p)
				}
			}
			if len(res) < 2 {
				t.Fatalf("no split window in %+v", all)
			}
			return res
		}
		zoomState := func(t *testing.T, pane string) bool {
			t.Helper()
			for _, p := range must(c.ListPanes(bg, s, ""))(t) {
				if p.ID == pane {
					return p.Zoomed
				}
			}
			return false
		}
		zoom := func(t *testing.T, pane string, want *bool) {
			t.Helper()
			if err := c.ZoomPane(bg, s, pane, want); err != nil {
				t.Fatal(err)
			}
		}
		run := func(name string, fn func(t *testing.T)) {
			t.Run(name, func(t *testing.T) {
				// Leave the window unzoomed whatever the test did, by pane
				// id: the current window is not always the one zoomed.
				// Unzooming a pane that is not zoomed is a no-op and would
				// leave the window zoomed, so take the zoomed one.
				t.Cleanup(func() {
					panes := splitPanes(t)
					pane := panes[0]
					if z := zoomedIn(panes); len(z) > 0 {
						pane = z[0]
					}
					if err := c.ZoomPane(bg, s, pane.ID, &no); err != nil {
						t.Errorf("unzoom: %v", err)
					}
				})
				fn(t)
			})
		}

		run("zooms the pane it was told to, not the one tmux had active", func(t *testing.T) {
			var inactive *protocol.PaneInfo
			for _, p := range splitPanes(t) {
				if !p.Active {
					inactive = &p
					break
				}
			}
			if inactive == nil {
				t.Fatal("no inactive pane")
			}
			zoom(t, inactive.ID, &yes)
			if !zoomState(t, inactive.ID) {
				t.Fatal("pane not zoomed")
			}
		})

		run("is idempotent, so a double tap does not undo itself", func(t *testing.T) {
			pane := splitPanes(t)[0]
			zoom(t, pane.ID, &yes)
			zoom(t, pane.ID, &yes)
			if !zoomState(t, pane.ID) {
				t.Fatal("pane not zoomed")
			}
		})

		run("unzooms idempotently too", func(t *testing.T) {
			pane := splitPanes(t)[0]
			zoom(t, pane.ID, &yes)
			zoom(t, pane.ID, &no)
			zoom(t, pane.ID, &no)
			if zoomState(t, pane.ID) {
				t.Fatal("pane still zoomed")
			}
		})

		run("moves the zoom to another pane rather than turning it off", func(t *testing.T) {
			// The case a toggle cannot express. Toggling a zoomed window
			// can only unzoom it.
			panes := splitPanes(t)
			a, b := panes[0], panes[1]
			zoom(t, a.ID, &yes)
			zoom(t, b.ID, &yes)
			if !zoomState(t, b.ID) {
				t.Fatal("b not zoomed")
			}
			if zoomState(t, a.ID) {
				t.Fatal("a still zoomed")
			}
		})

		run("still toggles when no state is asked for, for an older client", func(t *testing.T) {
			pane := splitPanes(t)[0]
			if err := c.SelectWindow(bg, pane.WindowID); err != nil {
				t.Fatal(err)
			}
			if err := c.SelectPane(bg, "", pane.ID); err != nil {
				t.Fatal(err)
			}
			before := zoomState(t, pane.ID)
			zoom(t, "", nil)
			if zoomState(t, pane.ID) == before {
				t.Fatalf("zoom stayed %v", before)
			}
		})

		// window_layout is the same zoomed and unzoomed, so a change
		// detector built on layout and counts cannot see a zoom. That let
		// prefix z on the machine leave the browser drawing a pane zoomed.
		run("reports zoom on the window, where a layout string cannot", func(t *testing.T) {
			pane := splitPanes(t)[0]
			window := func(t *testing.T) protocol.WindowInfo {
				t.Helper()
				for _, w := range must(c.ListWindows(bg, s))(t) {
					if w.ID == pane.WindowID {
						return w
					}
				}
				t.Fatalf("window %s missing", pane.WindowID)
				return protocol.WindowInfo{}
			}
			zoom(t, pane.ID, &yes)
			zoomed := window(t)
			if zoomed.Zoomed == nil || !*zoomed.Zoomed {
				t.Fatal("window not reported zoomed")
			}
			zoom(t, pane.ID, &no)
			flat := window(t)
			if flat.Zoomed == nil || *flat.Zoomed {
				t.Fatal("window still reported zoomed")
			}
			// The fields change detection used before did not move.
			if flat.Layout != zoomed.Layout || flat.PaneCount != zoomed.PaneCount {
				t.Fatalf("layout or count moved: %+v vs %+v", flat, zoomed)
			}
		})

		run("says false for a window with nothing zoomed in it", func(t *testing.T) {
			for _, w := range must(c.ListWindows(bg, s))(t) {
				if w.PaneCount == 1 {
					if w.Zoomed == nil || *w.Zoomed {
						t.Fatalf("single pane window %s zoomed %v", w.ID, w.Zoomed)
					}
					return
				}
			}
			t.Fatal("no single pane window")
		})
	})

	t.Run("reports the window tmux is actually showing", func(t *testing.T) {
		windows := must(c.ListWindows(bg, s))(t)
		if len(windows) != 3 {
			t.Fatalf("%d windows, want 3", len(windows))
		}
		active := ""
		for _, w := range windows {
			if w.Active {
				active = w.ID
			}
		}
		if got := currentWindow(t); got != active {
			t.Fatalf("current %s, active %s", got, active)
		}
	})

	t.Run("shows the window of a pane selected through its session", func(t *testing.T) {
		start := currentWindow(t)
		var other *protocol.PaneInfo
		for _, p := range must(c.ListPanes(bg, s, ""))(t) {
			if p.WindowID != start {
				other = &p
				break
			}
		}
		if other == nil {
			t.Fatal("no pane in another window")
		}
		t.Cleanup(func() { _ = c.SelectWindow(bg, start) })

		// Without the session tmux focuses the pane inside its own window
		// and the screen stays. A split sent next lands off target.
		if err := c.SelectPane(bg, "", other.ID); err != nil {
			t.Fatal(err)
		}
		if got := currentWindow(t); got != start {
			t.Fatalf("window moved to %s without the session", got)
		}
		if err := c.SelectPane(bg, s, other.ID); err != nil {
			t.Fatal(err)
		}
		if got := currentWindow(t); got != other.WindowID {
			t.Fatalf("current %s, want %s", got, other.WindowID)
		}
		active := activeIn(must(c.ListPanes(bg, s, other.WindowID))(t))
		if len(active) != 1 || active[0].ID != other.ID {
			t.Fatalf("active %+v, want %s", active, other.ID)
		}
	})

	t.Run("returns exactly one active pane when scoped to a window", func(t *testing.T) {
		current := currentWindow(t)
		panes := must(c.ListPanes(bg, s, current))(t)
		if len(panes) != 3 {
			t.Fatalf("%d panes, want 3", len(panes))
		}
		if n := len(activeIn(panes)); n != 1 {
			t.Fatalf("%d active panes, want 1", n)
		}
		for _, p := range panes {
			if p.WindowID != current {
				t.Fatalf("pane %s in window %s, want %s", p.ID, p.WindowID, current)
			}
		}
	})

	t.Run("returns one active pane PER WINDOW when unscoped, the trap", func(t *testing.T) {
		all := must(c.ListPanes(bg, s, ""))(t)
		if len(all) <= 3 {
			t.Fatalf("%d panes, want more than 3", len(all))
		}
		// Three windows, three active panes. Anything that takes the
		// first active one answers for window 1, whatever is on screen.
		if n := len(activeIn(all)); n != 3 {
			t.Fatalf("%d active panes, want 3", n)
		}
	})

	t.Run("marks only the zoomed AND active pane as zoomed", func(t *testing.T) {
		current := currentWindow(t)
		if err := c.ZoomPane(bg, s, "", nil); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.ZoomPane(bg, s, "", nil) })
		zoomed := zoomedIn(must(c.ListPanes(bg, s, current))(t))
		if len(zoomed) != 1 || !zoomed[0].Active {
			t.Fatalf("zoomed %+v, want one active pane", zoomed)
		}
	})

	t.Run("steps windows forwards and wraps", func(t *testing.T) {
		var order []string
		for _, w := range must(c.ListWindows(bg, s))(t) {
			order = append(order, w.ID)
		}
		start := currentWindow(t)
		at := indexOf(order, start)
		for i := 1; i <= len(order); i++ {
			if err := c.StepWindow(bg, s, 1); err != nil {
				t.Fatal(err)
			}
			if got, want := currentWindow(t), order[(at+i)%len(order)]; got != want {
				t.Fatalf("step %d: window %s, want %s", i, got, want)
			}
		}
		// A full lap ends where it started.
		if got := currentWindow(t); got != start {
			t.Fatalf("window %s after a lap, want %s", got, start)
		}
	})

	t.Run("steps windows backwards", func(t *testing.T) {
		var order []string
		for _, w := range must(c.ListWindows(bg, s))(t) {
			order = append(order, w.ID)
		}
		start := currentWindow(t)
		if err := c.StepWindow(bg, s, -1); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.StepWindow(bg, s, 1) })
		want := order[(indexOf(order, start)-1+len(order))%len(order)]
		if got := currentWindow(t); got != want {
			t.Fatalf("window %s, want %s", got, want)
		}
	})

	t.Run("steps panes inside the current window without leaving it", func(t *testing.T) {
		current := currentWindow(t)
		panes := must(c.ListPanes(bg, s, current))(t)
		if len(panes) < 2 {
			t.Fatalf("%d panes in the current window, want at least 2", len(panes))
		}
		before := activeIn(panes)[0].ID
		if err := c.StepPane(bg, s, 1); err != nil {
			t.Fatal(err)
		}
		after := activeIn(must(c.ListPanes(bg, s, current))(t))
		if len(after) != 1 || after[0].ID == before {
			t.Fatalf("active %+v, want one other than %s", after, before)
		}
		if got := currentWindow(t); got != current {
			t.Fatalf("window %s, want %s", got, current)
		}
	})

	t.Run("keeps the window zoomed across a pane step", func(t *testing.T) {
		current := currentWindow(t)
		if n := len(must(c.ListPanes(bg, s, current))(t)); n < 2 {
			t.Fatalf("%d panes in the current window, want at least 2", n)
		}
		if err := c.ZoomPane(bg, s, "", nil); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if len(zoomedIn(must(c.ListPanes(bg, s, current))(t))) > 0 {
				_ = c.ZoomPane(bg, s, "", nil)
			}
		})
		zoomed := zoomedIn(must(c.ListPanes(bg, s, current))(t))
		if len(zoomed) != 1 {
			t.Fatalf("zoomed %+v before the step", zoomed)
		}
		before := zoomed[0].ID
		if err := c.StepPane(bg, s, 1); err != nil {
			t.Fatal(err)
		}
		// Still zoomed, on another pane. The old unzoom, select, rezoom
		// triple kept getting this wrong.
		after := zoomedIn(must(c.ListPanes(bg, s, current))(t))
		if len(after) != 1 || after[0].ID == before {
			t.Fatalf("zoomed %+v after the step, want one other than %s", after, before)
		}
	})
}

func indexOf(list []string, v string) int {
	for i, x := range list {
		if x == v {
			return i
		}
	}
	return -1
}

// openTUI starts the raw tty app of main_test.go in a background window of
// the capture session and waits until its modes are on. It returns the
// pane id and the file its input lands in.
func (f *fixture) openTUI(t *testing.T, mode string) (pane, received string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	f.apps++
	received = filepath.Join(f.base, fmt.Sprintf("scroll-input-%d.bin", f.apps))
	ready := filepath.Join(f.base, fmt.Sprintf("scroll-ready-%d", f.apps))
	pane = strings.TrimSpace(f.tmux(t, "new-window", "-d", "-t", "="+captureSession+":",
		"-P", "-F", "#{pane_id}",
		"-e", ttyAppEnv+"="+mode, "-e", ttyOutEnv+"="+received, "-e", ttyReadyEnv+"="+ready,
		exe))
	t.Cleanup(func() { _, _ = f.try("kill-pane", "-t", pane) })

	poll(t, "tty app ready", 10*time.Second, 20*time.Millisecond, func() (bool, string) {
		_, err := os.Stat(ready)
		return err == nil, fmt.Sprint(err)
	})
	format := "#{mouse_any_flag}"
	if mode == "keys" {
		format = "#{alternate_on}"
	}
	poll(t, "tty app modes", 10*time.Second, 20*time.Millisecond, func() (bool, string) {
		out, err := f.try("display-message", "-p", "-t", pane, format)
		return err == nil && strings.TrimSpace(out) == "1", out
	})
	return pane, received
}

func readReceived(path string) []byte {
	b, _ := os.ReadFile(path)
	return b
}

func (f *fixture) testApplicationScrolling(t *testing.T) {
	c := f.c
	notInMode := func(t *testing.T, pane string) {
		t.Helper()
		if st := must(c.readScroll(bg, pane))(t); st.InMode {
			t.Fatalf("pane %s in copy mode", pane)
		}
	}

	for _, mode := range []string{"sgr", "inline"} {
		t.Run(fmt.Sprintf("routes %s mouse scrolling into app without copy mode", mode), func(t *testing.T) {
			pane, received := f.openTUI(t, mode)
			st := must(c.scrollHistory(bg, pane, 3))(t)
			must(c.scrollHistory(bg, pane, -2))(t)
			want := regexp.MustCompile(`(?:\x1b\[<64;\d+;\d+M){3}(?:\x1b\[<65;\d+;\d+M){2}`)
			poll(t, "wheel events", 10*time.Second, 20*time.Millisecond, func() (bool, string) {
				got := readReceived(received)
				return want.Match(got), string(got)
			})
			if st.InMode || st.Position != 0 || st.HistorySize != 0 {
				t.Fatalf("state %+v, want outside copy mode at 0 with no history", st)
			}
			notInMode(t, pane)
		})
	}

	t.Run("sends a long flick as one repeated event", func(t *testing.T) {
		// Each hex byte is its own send-keys argument, and tmux refused
		// the command as too long well under a hundred spelled out events.
		// A flick is the clamp, 500 lines, so it has to go through -N.
		pane, received := f.openTUI(t, "sgr")
		must(c.scrollHistory(bg, pane, 500))(t)
		event := regexp.MustCompile(`\x1b\[<64;\d+;\d+M`)
		poll(t, "500 wheel events", 10*time.Second, 20*time.Millisecond, func() (bool, string) {
			n := len(event.FindAll(readReceived(received), -1))
			return n == 500, strconv.Itoa(n)
		})
		notInMode(t, pane)
	})

	t.Run("encodes legacy mouse wheel bytes", func(t *testing.T) {
		pane, received := f.openTUI(t, "legacy")
		must(c.scrollHistory(bg, pane, 1))(t)
		poll(t, "six bytes", 10*time.Second, 20*time.Millisecond, func() (bool, string) {
			got := readReceived(received)
			return len(got) == 6, fmt.Sprintf("%v", got)
		})
		if got := readReceived(received)[:4]; !bytes.Equal(got, []byte{27, 91, 77, 96}) {
			t.Fatalf("event starts %v, want [27 91 77 96]", got)
		}
		notInMode(t, pane)
	})

	t.Run("uses arrow keys for alternate-screen apps without mouse support", func(t *testing.T) {
		pane, received := f.openTUI(t, "keys")
		must(c.scrollHistory(bg, pane, 2))(t)
		must(c.scrollHistory(bg, pane, -1))(t)
		poll(t, "arrow keys", 10*time.Second, 20*time.Millisecond, func() (bool, string) {
			got := string(readReceived(received))
			return got == "\x1b[A\x1b[A\x1b[B", got
		})
		notInMode(t, pane)
	})

	// The relay test "does not send application input for a read-only
	// viewer" does not carry over. The Go server has no read-only grant,
	// so application input is always allowed.

	t.Run("keeps explicit copy mode available over a TUI", func(t *testing.T) {
		pane, received := f.openTUI(t, "sgr")
		if err := c.enterCopyMode(bg, pane); err != nil {
			t.Fatal(err)
		}
		must(c.scrollHistory(bg, pane, 3))(t)
		if st := must(c.readScroll(bg, pane))(t); !st.InMode {
			t.Fatal("left copy mode")
		}
		if _, err := os.Stat(received); err == nil {
			t.Fatalf("app got input: %q", readReceived(received))
		}
	})
}

// Not in the relay test file: session lifecycle, exact names, errors and
// the clone sweep, against the same server.
func (f *fixture) testSessions(t *testing.T) {
	c := f.c

	t.Run("reports the tmux version", func(t *testing.T) {
		v := must(c.Version(bg))(t)
		if !strings.HasPrefix(v, "tmux ") {
			t.Fatalf("version %q", v)
		}
	})

	t.Run("lists nothing without a server", func(t *testing.T) {
		for name, sock := range map[string]string{
			"no socket file": filepath.Join(f.base, "none", "sock"),
			"stale socket":   f.staleSocket(t),
		} {
			t.Run(name, func(t *testing.T) {
				none := New(Options{Socket: sock, Logger: quiet})
				sessions, err := none.ListSessions(bg)
				if err != nil || sessions == nil || len(sessions) != 0 {
					t.Fatalf("ListSessions = %v, %v, want empty and nil", sessions, err)
				}
				names, err := none.SessionNames(bg)
				if err != nil || names == nil || len(names) != 0 {
					t.Fatalf("SessionNames = %v, %v, want empty and nil", names, err)
				}
				if none.SessionExists(bg, captureSession) {
					t.Fatal("SessionExists without a server")
				}
				if n := none.SweepOrphanClones(bg); n != 0 {
					t.Fatalf("SweepOrphanClones = %d", n)
				}
				if _, err := none.ListWindows(bg, captureSession); !errors.Is(err, ErrNoServer) {
					t.Fatalf("ListWindows err = %v, want ErrNoServer", err)
				}
			})
		}
	})

	t.Run("creates, lists, renames and kills a session", func(t *testing.T) {
		info := must(c.CreateSession(bg, "tmuxde-life", f.base, "sleep 600"))(t)
		t.Cleanup(func() { _, _ = f.try("kill-session", "-t", "=-life") })
		if info.Name != "tmuxde-life" || !strings.HasPrefix(info.ID, "$") ||
			info.Windows != 1 || info.Attached || info.Dimensions != nil {
			t.Fatalf("created %+v", info)
		}
		if _, err := time.Parse("2006-01-02T15:04:05.000Z", info.Created); err != nil || info.Activity != info.Created {
			t.Fatalf("timestamps %q %q: %v", info.Created, info.Activity, err)
		}
		var listed *protocol.SessionInfo
		for _, s := range must(c.ListSessions(bg))(t) {
			if s.Name == "tmuxde-life" {
				listed = &s
			}
		}
		if listed == nil || listed.ID != info.ID || listed.Dimensions == nil {
			t.Fatalf("listed %+v", listed)
		}
		// A name that starts with a dash is not a flag.
		if err := c.RenameSession(bg, "tmuxde-life", "-life"); err != nil {
			t.Fatal(err)
		}
		if c.SessionExists(bg, "tmuxde-life") || !c.SessionExists(bg, "-life") {
			t.Fatal("rename did not take")
		}
		if err := c.KillSession(bg, "-life"); err != nil {
			t.Fatal(err)
		}
		if c.SessionExists(bg, "-life") {
			t.Fatal("session survived the kill")
		}
	})

	t.Run("matches session names exactly", func(t *testing.T) {
		must(c.CreateSession(bg, "exact-match-target", "", "sleep 600"))(t)
		t.Cleanup(func() { _, _ = f.try("kill-session", "-t", "=exact-match-target") })
		if c.SessionExists(bg, "exact-match") {
			t.Fatal("a prefix matched")
		}
		if c.SessionExists(bg, "exact-*") {
			t.Fatal("a pattern matched")
		}
		err := c.KillSession(bg, "exact-match")
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("KillSession(prefix) = %v, want ErrNotFound", err)
		}
		var ce *CommandError
		if !errors.As(err, &ce) || ce.ExitCode != 1 ||
			err.Error() != "tmux kill-session: can't find session: exact-match" {
			t.Fatalf("error %#v", err)
		}
		if !c.SessionExists(bg, "exact-match-target") {
			t.Fatal("the full name was killed")
		}
		if _, err := c.CurrentWindowID(bg, "exact-match"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("CurrentWindowID(prefix) = %v, want ErrNotFound", err)
		}
		if _, err := c.CapturePane(bg, "exact-match", CaptureOptions{}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("CapturePane(prefix) = %v, want ErrNotFound", err)
		}

		// list-panes takes a window target even with -s. A bare "=0" is
		// window index 0 of the current session, and "=claude" is the
		// window of that name in "work". "work" is made last, so it is the
		// current session.
		t.Run("lists the panes of the named session only", func(t *testing.T) {
			names := []string{"0", "claude", "work"}
			for _, s := range names {
				f.tmux(t, "new-session", "-d", "-s", s, "sleep 600")
				t.Cleanup(func() { _, _ = f.try("kill-session", "-t", "="+s) })
				if s == "0" {
					f.tmux(t, "split-window", "-t", "=0:", "sleep 600")
				}
			}
			f.tmux(t, "rename-window", "-t", "=work:", "claude")
			want := map[string][]string{}
			all := strings.TrimSpace(f.tmux(t, "list-panes", "-a", "-F", "#{session_name}\t#{pane_id}"))
			for _, line := range strings.Split(all, "\n") {
				name, id, _ := strings.Cut(line, "\t")
				want[name] = append(want[name], id)
			}
			for _, s := range names {
				var got []string
				for _, p := range must(c.ListPanes(bg, s, ""))(t) {
					got = append(got, p.ID)
				}
				if len(want[s]) == 0 || !slices.Equal(got, want[s]) {
					t.Errorf("ListPanes(%q, \"\") = %v, want %v", s, got, want[s])
				}
			}
		})

		// tmux reads "$0" as session id $0 before any name, so such a name
		// is refused before tmux runs. The capture session is $0 here.
		t.Run("refuses a name that reads as a session id", func(t *testing.T) {
			id := strings.TrimSpace(f.tmux(t, "new-session", "-d", "-s", "$0", "-P", "-F", "#{session_id}", "sleep 600"))
			t.Cleanup(func() { _, _ = f.try("kill-session", "-t", id) })
			if got := strings.TrimSpace(f.tmux(t, "display-message", "-p", "-t", "$0", "#{session_name}")); got != captureSession {
				t.Fatalf("session $0 is %q, want %q", got, captureSession)
			}
			if c.SessionExists(bg, "$0") {
				t.Fatal("SessionExists($0) read the session id")
			}
			if err := c.KillSession(bg, "$0"); !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("KillSession($0) = %v, want ErrInvalidArgument", err)
			}
			if _, err := c.ListPanes(bg, "$0", ""); !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("ListPanes($0) = %v, want ErrInvalidArgument", err)
			}
			if !c.SessionExists(bg, captureSession) {
				t.Fatal("the session with id $0 was killed")
			}
			if got := strings.TrimSpace(f.tmux(t, "display-message", "-p", "-t", id, "#{session_name}")); got != "$0" {
				t.Fatalf("session %s is %q, want $0", id, got)
			}
		})
	})

	// tmux 3.3a creates "$0" and "a/b" as asked. Neither could be reached
	// by name afterwards, so both are refused before tmux runs.
	t.Run("refuses new names tmux would misread", func(t *testing.T) {
		const keep = "rename-guard"
		f.tmux(t, "new-session", "-d", "-s", keep, "sleep 600")
		t.Cleanup(func() { _, _ = f.try("kill-session", "-t", "="+keep) })
		ids := func() []string {
			return strings.Fields(f.tmux(t, "list-sessions", "-F", "#{session_id}"))
		}
		before := ids()
		t.Cleanup(func() {
			// Only runs into work when a refused name was created anyway.
			for _, id := range ids() {
				if !slices.Contains(before, id) {
					_, _ = f.try("kill-session", "-t", id)
				}
			}
		})
		for _, name := range []string{"$0", "a/b"} {
			if _, err := c.CreateSession(bg, name, "", "sleep 600"); !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("CreateSession(%q) = %v, want ErrInvalidArgument", name, err)
			}
			if err := c.RenameSession(bg, keep, name); !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("RenameSession(%q) = %v, want ErrInvalidArgument", name, err)
			}
		}
		after := f.tmux(t, "list-sessions", "-F", "#{session_id}\t#{session_name}")
		if !slices.Equal(ids(), before) {
			t.Fatalf("sessions changed: %q", after)
		}
		if !c.SessionExists(bg, keep) {
			t.Fatalf("%s was renamed: %q", keep, after)
		}
	})

	t.Run("sweeps orphan clones and nothing else", func(t *testing.T) {
		for _, name := range []string{ClonePrefix + "a_1", ClonePrefix + "b_2", "__tmuxde"} {
			must(c.CreateSession(bg, name, "", "sleep 600"))(t)
		}
		t.Cleanup(func() { _, _ = f.try("kill-session", "-t", "=__tmuxde") })
		if n := c.SweepOrphanClones(bg); n != 2 {
			t.Fatalf("swept %d, want 2", n)
		}
		names := must(c.SessionNames(bg))(t)
		for _, n := range names {
			if IsClone(n) {
				t.Fatalf("clone %q survived", n)
			}
		}
		if !c.SessionExists(bg, "__tmuxde") || !c.SessionExists(bg, captureSession) {
			t.Fatalf("sweep killed too much: %q", names)
		}
		if n := c.SweepOrphanClones(bg); n != 0 {
			t.Fatalf("second sweep found %d", n)
		}
	})

	t.Run("probes select-pane -Z once and safely from many goroutines", func(t *testing.T) {
		fresh := New(Options{Socket: f.sock, Logger: quiet})
		var wg sync.WaitGroup
		results := make([]bool, 8)
		for i := range results {
			wg.Go(func() { results[i] = fresh.selectPaneZ(bg) })
		}
		wg.Wait()
		for i, ok := range results {
			if !ok {
				t.Fatalf("probe %d said no on tmux 3.3a", i)
			}
		}
	})
}

// staleSocket leaves a socket file that nobody listens on, as a tmux
// server does when it exits.
func (f *fixture) staleSocket(t *testing.T) string {
	t.Helper()
	sock := filepath.Join(f.base, "stale")
	other := &fixture{base: f.base, sock: sock, conf: f.conf, env: f.env}
	other.tmux(t, "new-session", "-d", "-s", "x", "sleep 600")
	other.tmux(t, "kill-server")
	poll(t, "stale socket", 10*time.Second, 20*time.Millisecond, func() (bool, string) {
		_, err := other.try("list-sessions")
		return err != nil && strings.Contains(err.Error(), "no server running"), fmt.Sprint(err)
	})
	return sock
}

// Not in the relay test file: the window and pane commands the browser
// sends, on a session of their own.
func (f *fixture) testLayoutAndPaneCommands(t *testing.T) {
	c := f.c
	const s = "tmuxde-layout"
	f.tmux(t, "new-session", "-d", "-s", s, "-x", "200", "-y", "50")
	t.Cleanup(func() { _, _ = f.try("kill-session", "-t", "="+s) })

	if err := c.CreateWindow(bg, s, "-work"); err != nil {
		t.Fatal(err)
	}
	windowID, panes := must2(c.CurrentWindowPanes(bg, s))(t)
	if len(panes) != 1 || panes[0].WindowID != windowID {
		t.Fatalf("new window %s panes %+v", windowID, panes)
	}
	windows := must(c.ListWindows(bg, s))(t)
	if len(windows) != 2 || windows[1].Name != "-work" || !windows[1].Active {
		t.Fatalf("windows %+v", windows)
	}
	if err := c.RenameWindow(bg, windowID, "-renamed"); err != nil {
		t.Fatal(err)
	}
	if got := must(c.ListWindows(bg, s))(t)[1].Name; got != "-renamed" {
		t.Fatalf("window name %q", got)
	}

	for _, dir := range []string{"h", "v"} {
		if err := c.SplitPane(bg, s, dir); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.SelectLayout(bg, s, "even-horizontal"); err != nil {
		t.Fatal(err)
	}
	panes = must(c.ListPanes(bg, s, windowID))(t)
	if len(panes) != 3 || panes[0].Dimensions.Rows != panes[1].Dimensions.Rows {
		t.Fatalf("even-horizontal panes %+v", panes)
	}
	first := panes[0]
	if err := c.ResizePane(bg, first.ID, "R", 5); err != nil {
		t.Fatal(err)
	}
	resized := must(c.ListPanes(bg, s, windowID))(t)[0]
	if resized.ID != first.ID || resized.Dimensions.Cols != first.Dimensions.Cols+5 {
		t.Fatalf("resized %+v from %+v", resized, first)
	}
	if err := c.SwapPane(bg, first.ID, "D"); err != nil {
		t.Fatal(err)
	}
	if got := must(c.ListPanes(bg, s, windowID))(t); got[0].ID == first.ID {
		t.Fatalf("swap did not move %s: %+v", first.ID, got)
	}
	if err := c.RotateLayout(bg, s); err != nil {
		t.Fatal(err)
	}
	if err := c.SendPrefix(bg, s); err != nil {
		t.Fatal(err)
	}
	if err := c.SendInterrupt(bg, s); err != nil {
		t.Fatal(err)
	}
	if err := c.EnterCopyMode(bg, s); err != nil {
		t.Fatal(err)
	}
	if !must(c.ReadScrollState(bg, s))(t).InMode {
		t.Fatal("EnterCopyMode did not enter")
	}
	if err := c.ExitCopyMode(bg, s); err != nil {
		t.Fatal(err)
	}
	if err := c.KillPane(bg, first.ID); err != nil {
		t.Fatal(err)
	}
	if n := len(must(c.ListPanes(bg, s, windowID))(t)); n != 2 {
		t.Fatalf("%d panes after kill, want 2", n)
	}
	if err := c.KillWindow(bg, windowID); err != nil {
		t.Fatal(err)
	}
	if n := len(must(c.ListWindows(bg, s))(t)); n != 1 {
		t.Fatalf("%d windows after kill, want 1", n)
	}
	if err := c.KillPane(bg, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("KillPane(gone) = %v, want ErrNotFound", err)
	}
}

// Not in the relay test file: pane:swap with a target, pane:join and
// pane:break, the moves a drag in the sidebar grid sends. Each step checks
// where the panes went, which pane tmux made active and which window the
// session shows.
func (f *fixture) testPaneMoves(t *testing.T) {
	c := f.c
	const s, other = "tmuxde-moves", "tmuxde-moves-other"
	// -P prints the new pane id. The panes run sleep, so no shell differs
	// between hosts.
	newPane := func(t *testing.T, args ...string) string {
		t.Helper()
		return strings.TrimSpace(f.tmux(t, append(args, "-P", "-F", "#{pane_id}", "sleep 600")...))
	}
	a := newPane(t, "new-session", "-d", "-s", s, "-x", "200", "-y", "50")
	t.Cleanup(func() { _, _ = f.try("kill-session", "-t", "="+s) })
	b := newPane(t, "split-window", "-h", "-t", a)
	c3 := newPane(t, "new-window", "-t", "="+s+":")
	// Created last, so it is the session tmux would pick on its own.
	f.tmux(t, "new-session", "-d", "-s", other, "sleep 600")
	t.Cleanup(func() { _, _ = f.try("kill-session", "-t", "="+other) })
	if err := c.SelectPane(bg, s, a); err != nil {
		t.Fatal(err)
	}

	// ids lists the pane ids of a window in tmux order, the active one
	// marked with a star.
	ids := func(t *testing.T, windowID string) []string {
		t.Helper()
		var out []string
		for _, p := range must(c.ListPanes(bg, s, windowID))(t) {
			if p.Active {
				out = append(out, p.ID+"*")
			} else {
				out = append(out, p.ID)
			}
		}
		return out
	}
	windowOf := func(t *testing.T, paneID string) string {
		t.Helper()
		return strings.TrimSpace(f.tmux(t, "display-message", "-p", "-t", paneID, "#{window_id}"))
	}
	w0, w1 := windowOf(t, a), windowOf(t, c3)

	t.Run("swaps two panes of one window and activates the target", func(t *testing.T) {
		if err := c.SwapPanes(bg, a, b); err != nil {
			t.Fatal(err)
		}
		if got, want := ids(t, w0), []string{b + "*", a}; !slices.Equal(got, want) {
			t.Fatalf("window %s panes %v, want %v", w0, got, want)
		}
	})

	t.Run("swaps panes across windows and keeps the window on screen", func(t *testing.T) {
		before := must(c.CurrentWindowID(bg, s))(t)
		if err := c.SwapPanes(bg, a, c3); err != nil {
			t.Fatal(err)
		}
		// Each window activates the pane it received.
		if got, want := ids(t, w0), []string{b, c3 + "*"}; !slices.Equal(got, want) {
			t.Fatalf("window %s panes %v, want %v", w0, got, want)
		}
		if got, want := ids(t, w1), []string{a + "*"}; !slices.Equal(got, want) {
			t.Fatalf("window %s panes %v, want %v", w1, got, want)
		}
		if got := must(c.CurrentWindowID(bg, s))(t); got != before {
			t.Fatalf("current window %s, was %s", got, before)
		}
	})

	t.Run("joins a pane below the active pane and shows its new window", func(t *testing.T) {
		if err := c.SelectWindow(bg, w1); err != nil {
			t.Fatal(err)
		}
		if err := c.JoinPane(bg, a, w0, "v"); err != nil {
			t.Fatal(err)
		}
		if got, want := ids(t, w0), []string{b, c3, a + "*"}; !slices.Equal(got, want) {
			t.Fatalf("window %s panes %v, want %v", w0, got, want)
		}
		panes := must(c.ListPanes(bg, s, w0))(t)
		split, joined := panes[1], panes[2]
		if joined.Position.X != split.Position.X || joined.Position.Y <= split.Position.Y {
			t.Fatalf("joined %+v is not below %+v", joined.Position, split.Position)
		}
		if got := must(c.CurrentWindowID(bg, s))(t); got != w0 {
			t.Fatalf("current window %s, want %s", got, w0)
		}
		// The window the pane left had no other pane and closed.
		if windows := must(c.ListWindows(bg, s))(t); len(windows) != 1 || windows[0].ID != w0 {
			t.Fatalf("windows %+v, want only %s", windows, w0)
		}
	})

	t.Run("joins beside the active pane for h", func(t *testing.T) {
		w := windowOf(t, newPane(t, "new-window", "-t", "="+s+":"))
		if err := c.JoinPane(bg, b, w, "h"); err != nil {
			t.Fatal(err)
		}
		panes := must(c.ListPanes(bg, s, w))(t)
		if len(panes) != 2 || panes[1].ID != b || panes[1].Position.Y != panes[0].Position.Y ||
			panes[1].Position.X <= panes[0].Position.X {
			t.Fatalf("window %s panes %+v, want %s right of the first", w, panes, b)
		}
		if got := must(c.CurrentWindowID(bg, s))(t); got != w {
			t.Fatalf("current window %s, want %s", got, w)
		}
	})

	t.Run("breaks a pane out into a new window of its own session", func(t *testing.T) {
		before := len(must(c.ListWindows(bg, s))(t))
		otherBefore := len(must(c.ListWindows(bg, other))(t))
		if err := c.BreakPane(bg, s, a); err != nil {
			t.Fatal(err)
		}
		w := windowOf(t, a)
		if w == w0 {
			t.Fatalf("%s is still in window %s", a, w0)
		}
		if got := len(must(c.ListWindows(bg, s))(t)); got != before+1 {
			t.Fatalf("%d windows, want %d", got, before+1)
		}
		if got := len(must(c.ListWindows(bg, other))(t)); got != otherBefore {
			t.Fatalf("%s has %d windows, had %d", other, got, otherBefore)
		}
		if got, want := ids(t, w), []string{a + "*"}; !slices.Equal(got, want) {
			t.Fatalf("window %s panes %v, want %v", w, got, want)
		}
		if got := must(c.CurrentWindowID(bg, s))(t); got != w {
			t.Fatalf("current window %s, want %s", got, w)
		}
	})

	t.Run("reports the tmux error for a join onto the pane itself", func(t *testing.T) {
		// a is the only and so the active pane of its window.
		if err := c.JoinPane(bg, a, windowOf(t, a), "h"); err == nil {
			t.Fatal("join onto itself succeeded")
		}
	})
}

// Not in the relay test file: which pane a border drag in the sidebar grid
// sends to resize-pane. The layouts and owners are the ones sharedBorders in
// ui/src/features/panes/pane-grid-layout.test.ts predicts. Each check applies
// its layout again, resizes one pane and reads back where the panes on both
// sides of the border ended.
func (f *fixture) testResizeOwner(t *testing.T) {
	c := f.c
	type check struct {
		name string
		// Pane to resize, a letter for the pane at that position in the
		// layout: a is the first leaf, b the second.
		pane      string
		direction string
		amount    int
		// The border: vertical divides left from right. cell is the
		// separator column or row. before and after are the panes that
		// touch it.
		vertical      bool
		cell          int
		before, after string
		// moves is false for a pane that sharedBorders says does not own
		// this border. resize-pane then moves another border.
		moves bool
	}
	cases := []struct {
		name   string
		layout string
		checks []check
	}{
		{
			// 0 on the left at full height. 1 over 2 on the right.
			name:   "pane left of a nested stack",
			layout: "81x24,0,0{40x24,0,0,0,40x24,41,0[40x11,41,0,1,40x12,41,12,2]}",
			checks: []check{
				{name: "owner grows right", pane: "a", direction: "R", amount: 5, vertical: true, cell: 40, before: "a", after: "bc", moves: true},
				{name: "owner moves it back", pane: "a", direction: "L", amount: 3, vertical: true, cell: 40, before: "a", after: "bc", moves: true},
				{name: "stack border down", pane: "b", direction: "D", amount: 2, vertical: false, cell: 11, before: "b", after: "c", moves: true},
				{name: "stack border up", pane: "b", direction: "U", amount: 4, vertical: false, cell: 11, before: "b", after: "c", moves: true},
			},
		},
		{
			// The plan mockup: 0 top left, 1 over 2 top right, 3 across the bottom.
			name:   "row above a full width pane",
			layout: "81x24,0,0[81x16,0,0{48x16,0,0,0,32x16,49,0[32x8,49,0,1,32x7,49,9,2]},81x7,0,17,3]",
			checks: []check{
				{name: "outer border down", pane: "a", direction: "D", amount: 2, vertical: false, cell: 16, before: "ac", after: "d", moves: true},
				{name: "outer border up", pane: "a", direction: "U", amount: 3, vertical: false, cell: 16, before: "ac", after: "d", moves: true},
				{name: "top row split right", pane: "a", direction: "R", amount: 4, vertical: true, cell: 48, before: "a", after: "bc", moves: true},
				{name: "nested stack down", pane: "b", direction: "D", amount: 1, vertical: false, cell: 8, before: "b", after: "c", moves: true},
			},
		},
		{
			// Two rows of two. The vertical borders line up on screen and
			// still move apart.
			name:   "two rows of two",
			layout: "81x25,0,0[81x12,0,0{40x12,0,0,0,40x12,41,0,1},81x12,0,13{40x12,0,13,2,40x12,41,13,3}]",
			checks: []check{
				{name: "row border from the top left pane", pane: "a", direction: "D", amount: 3, vertical: false, cell: 12, before: "ab", after: "cd", moves: true},
				{name: "top row only", pane: "a", direction: "R", amount: 6, vertical: true, cell: 40, before: "a", after: "b", moves: true},
				{name: "bottom row untouched by the top owner", pane: "a", direction: "R", amount: 6, vertical: true, cell: 40, before: "c", after: "d", moves: false},
				{name: "bottom row from its own owner", pane: "c", direction: "L", amount: 2, vertical: true, cell: 40, before: "c", after: "d", moves: true},
			},
		},
		{
			// Left: a stack of two side by side pairs. Right: pane 4.
			name:   "owner on the far side",
			layout: "81x25,0,0{40x25,0,0[40x12,0,0{20x12,0,0,0,19x12,21,0,1},40x12,0,13{20x12,0,13,2,19x12,21,13,3}],40x25,41,0,4}",
			checks: []check{
				{name: "last cell moves the outer border left", pane: "e", direction: "L", amount: 4, vertical: true, cell: 40, before: "bd", after: "e", moves: true},
				{name: "last cell moves the outer border right", pane: "e", direction: "R", amount: 2, vertical: true, cell: 40, before: "bd", after: "e", moves: true},
				{name: "a pane in a pair stops at the pair", pane: "b", direction: "R", amount: 2, vertical: true, cell: 40, before: "bd", after: "e", moves: false},
				{name: "pair border from its first pane", pane: "a", direction: "R", amount: 3, vertical: true, cell: 20, before: "a", after: "b", moves: true},
			},
		},
		{
			// The same stack with two panes on the right. No pane moves
			// the border after the stack alone.
			name:   "border without an owner",
			layout: "122x25,0,0{40x25,0,0[40x12,0,0{20x12,0,0,0,19x12,21,0,1},40x12,0,13{20x12,0,13,2,19x12,21,13,3}],40x25,41,0,4,40x25,82,0,5}",
			checks: []check{
				{name: "pair pane a", pane: "a", direction: "R", amount: 2, vertical: true, cell: 40, before: "bd", after: "e", moves: false},
				{name: "pair pane b", pane: "b", direction: "R", amount: 2, vertical: true, cell: 40, before: "bd", after: "e", moves: false},
				{name: "pair pane c", pane: "c", direction: "R", amount: 2, vertical: true, cell: 40, before: "bd", after: "e", moves: false},
				{name: "pair pane d", pane: "d", direction: "R", amount: 2, vertical: true, cell: 40, before: "bd", after: "e", moves: false},
				{name: "middle pane", pane: "e", direction: "R", amount: 2, vertical: true, cell: 40, before: "bd", after: "e", moves: false},
				{name: "last pane", pane: "f", direction: "R", amount: 2, vertical: true, cell: 40, before: "bd", after: "e", moves: false},
				{name: "middle pane owns the next border", pane: "e", direction: "R", amount: 2, vertical: true, cell: 81, before: "e", after: "f", moves: true},
			},
		},
	}

	type edges struct{ left, top, right, bottom int }
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := regexp.MustCompile(`^(\d+)x(\d+),`).FindStringSubmatch(tc.layout)
			leaves := len(regexp.MustCompile(`\d+x\d+,\d+,\d+,\d+`).FindAllString(tc.layout, -1))
			s := fmt.Sprintf("tmuxde-resize-%d", i)
			// sleep, not a shell, so no prompt or rc file differs between hosts.
			first := strings.TrimSpace(f.tmux(t, "new-session", "-d", "-s", s, "-x", root[1], "-y", root[2],
				"-P", "-F", "#{pane_id}", "sleep 600"))
			t.Cleanup(func() { _, _ = f.try("kill-session", "-t", "="+s) })
			ids := []string{first}
			for len(ids) < leaves {
				// A new pane goes after the active one, which is the last
				// one made, so tmux order is creation order. tiled keeps
				// room for the next split.
				ids = append(ids, strings.TrimSpace(f.tmux(t, "split-window", "-t", ids[len(ids)-1],
					"-P", "-F", "#{pane_id}", "sleep 600")))
				f.tmux(t, "select-layout", "-t", "="+s+":", "tiled")
			}
			pane := func(letter byte) string { return ids[letter-'a'] }
			read := func(t *testing.T) map[string]edges {
				t.Helper()
				out := map[string]edges{}
				for _, line := range strings.Split(strings.TrimSpace(f.tmux(t, "list-panes", "-t", "="+s+":",
					"-F", "#{pane_id} #{pane_left} #{pane_top} #{pane_right} #{pane_bottom}")), "\n") {
					var id string
					var e edges
					if _, err := fmt.Sscan(line, &id, &e.left, &e.top, &e.right, &e.bottom); err != nil {
						t.Fatalf("list-panes line %q: %v", line, err)
					}
					out[id] = e
				}
				return out
			}
			// Where the border is, read from the panes beside it: the last
			// column or row before it and the first one after it.
			border := func(t *testing.T, all map[string]edges, ch check) (before, after []int) {
				t.Helper()
				for _, l := range []byte(ch.before) {
					if e := all[pane(l)]; ch.vertical {
						before = append(before, e.right)
					} else {
						before = append(before, e.bottom)
					}
				}
				for _, l := range []byte(ch.after) {
					if e := all[pane(l)]; ch.vertical {
						after = append(after, e.left)
					} else {
						after = append(after, e.top)
					}
				}
				return before, after
			}
			same := func(list []int, want int) bool {
				return !slices.ContainsFunc(list, func(v int) bool { return v != want })
			}

			for _, ch := range tc.checks {
				t.Run(ch.name, func(t *testing.T) {
					body := tc.layout
					f.tmux(t, "select-layout", "-t", "="+s+":", layoutChecksum(body)+","+body)
					windows, err := c.ListWindows(bg, s)
					if err != nil || len(windows) != 1 {
						t.Fatalf("ListWindows: %v, %v", windows, err)
					}
					got := windows[0].Layout
					// The ids differ from the test layout. Sizes and offsets must not.
					strip := regexp.MustCompile(`(\d+x\d+,\d+,\d+),\d+`)
					if len(got) < 5 || strip.ReplaceAllString(got[5:], "$1") != strip.ReplaceAllString(body, "$1") {
						t.Fatalf("layout %q, want the shape of %q", got, body)
					}
					before, after := border(t, read(t), ch)
					if !same(before, ch.cell-1) || !same(after, ch.cell+1) {
						t.Fatalf("border at %d: before %v, after %v", ch.cell, before, after)
					}
					if err := c.ResizePane(bg, pane(ch.pane[0]), ch.direction, ch.amount); err != nil {
						t.Fatal(err)
					}
					delta := ch.amount
					if ch.direction == "L" || ch.direction == "U" {
						delta = -delta
					}
					want := ch.cell
					if ch.moves {
						want += delta
					}
					before, after = border(t, read(t), ch)
					if !same(before, want-1) || !same(after, want+1) {
						t.Fatalf("resize-pane -%s %d on %s: border before %v, after %v, want %d and %d",
							ch.direction, ch.amount, ch.pane, before, after, want-1, want+1)
					}
				})
			}
		})
	}
}

func must2[A, B any](a A, b B, err error) func(*testing.T) (A, B) {
	return func(t *testing.T) (A, B) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return a, b
	}
}

// TestIntegrationDefaultShell runs new sessions and windows on a server of its own.
// The server starts with -f /dev/null, then a config file sets
// default-command to a marker script. With DefaultShell set, tmux gets it
// as the command and the marker of the shell shows. Without it, tmux gets
// no command and applies default-command, then default-shell.
//
// Each script prints its marker, 42 and its argument count. tmux runs a
// command as "default-shell -c command", so a default-shell script that
// was handed a command shows 2 where one started as login shell shows 0.
func TestIntegrationDefaultShell(t *testing.T) {
	f := newFixture(t)
	f.conf = os.DevNull
	script := func(name, marker string) string {
		path := filepath.Join(f.base, name)
		// $((6*7)) so the script text never matches the marker.
		body := "#!/bin/sh\necho " + marker + "-$((6*7))-$#\nexec sleep 600\n"
		if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
		return path
	}
	const (
		cmdMarker   = "from-default-command"
		shellMarker = "from-tmuxde-shell"
		loginMarker = "from-default-shell"
	)
	cmdScript := script("default-command.sh", cmdMarker)
	shellScript := script("tmuxde-shell.sh", shellMarker)
	loginScript := script("default-shell.sh", loginMarker)
	conf := filepath.Join(f.base, "default-command.conf")
	body := "set -g default-shell /bin/sh\nset -g default-command '" + cmdScript + "'\n"
	if err := os.WriteFile(conf, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	f.tmux(t, "new-session", "-d", "-s", "keep", "sleep 600")
	f.tmux(t, "source-file", conf)

	// shows waits until the current pane of session shows want-42-0. It
	// fails when another marker shows instead.
	shows := func(t *testing.T, session, want string) {
		t.Helper()
		poll(t, session+" shows "+want, 10*time.Second, 20*time.Millisecond, func() (bool, string) {
			out, err := f.try("capture-pane", "-p", "-t", "="+session+":")
			for _, m := range []string{cmdMarker, shellMarker, loginMarker} {
				if strings.Contains(out, m+"-42") && !strings.Contains(out, want+"-42-0") {
					t.Fatalf("%s runs the wrong command, want %s-42-0: %q", session, want, out)
				}
			}
			return err == nil && strings.Contains(out, want+"-42-0"), out
		})
	}
	// check creates a session with no command and a window in a session
	// that runs something else, and waits for want in both.
	check := func(t *testing.T, c *Client, prefix, want string) {
		t.Helper()
		s := prefix + "-session"
		must(c.CreateSession(bg, s, "", ""))(t)
		shows(t, s, want)
		w := prefix + "-window"
		must(c.CreateSession(bg, w, "", "sleep 600"))(t)
		if err := c.CreateWindow(bg, w, "new"); err != nil {
			t.Fatal(err)
		}
		shows(t, w, want)
	}

	t.Run("DefaultShell set wins over default-command", func(t *testing.T) {
		check(t, New(Options{Socket: f.sock, DefaultShell: shellScript, Logger: quiet}), "set", shellMarker)
	})
	t.Run("no DefaultShell applies default-command", func(t *testing.T) {
		check(t, New(Options{Socket: f.sock, Logger: quiet}), "unset", cmdMarker)
	})
	t.Run("no DefaultShell and no default-command applies default-shell", func(t *testing.T) {
		f.tmux(t, "set-option", "-g", "default-command", "")
		f.tmux(t, "set-option", "-g", "default-shell", loginScript)
		check(t, New(Options{Socket: f.sock, Logger: quiet}), "login", loginMarker)
	})
}

// TestIntegrationNewSessionFolder checks that a new session or window that names no
// folder starts in Options.Dir, not in the folder of the process. The
// server is started from the process folder first, so neither the server
// nor tmux defaults can pass for Dir.
func TestIntegrationNewSessionFolder(t *testing.T) {
	f := newFixture(t)
	f.conf = os.DevNull
	f.tmux(t, "new-session", "-d", "-s", "keep", "sleep 600")
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(f.base, "home")
	sub := filepath.Join(f.base, "sub")
	for _, d := range []string{dir, sub} {
		if err := os.Mkdir(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	paths := func(t *testing.T, session string) []string {
		t.Helper()
		return strings.Fields(f.tmux(t, "list-panes", "-s", "-t", "="+session, "-F", "#{pane_current_path}"))
	}
	if got := paths(t, "keep"); !slices.Equal(got, []string{wd}) {
		t.Fatalf("fixture session starts in %v, want the process folder %s", got, wd)
	}

	c := New(Options{Socket: f.sock, Dir: dir, DefaultShell: "sleep 600", Logger: quiet})
	must(c.CreateSession(bg, "home", "", ""))(t)
	if err := c.CreateWindow(bg, "home", "second"); err != nil {
		t.Fatal(err)
	}
	if got := paths(t, "home"); !slices.Equal(got, []string{dir, dir}) {
		t.Fatalf("session and window start in %v, want %s twice", got, dir)
	}

	must(c.CreateSession(bg, "sub", sub, ""))(t)
	if got := paths(t, "sub"); !slices.Equal(got, []string{sub}) {
		t.Fatalf("session with a folder starts in %v, want %s", got, sub)
	}
}
