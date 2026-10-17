package tmux

import (
	"context"
	"errors"
	"log/slog"
	"os"

	"path/filepath"

	"strings"
	"testing"
)

var quiet = slog.New(slog.DiscardHandler)

func TestCommandErrorMapping(t *testing.T) {
	dir := t.TempDir()
	existing := filepath.Join(dir, "sock")
	if err := os.WriteFile(existing, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "gone", "sock")

	tests := []struct {
		name               string
		stderr             string
		noServer, notFound bool
	}{
		{"stale socket", "no server running on /tmp/tmux-1000/default\n", true, false},
		{"no socket file", "error connecting to " + missing + " (No such file or directory)\n", true, false},
		// strerror follows the locale. The missing path decides.
		{"no socket file, other locale", "error connecting to " + missing + " (Datei oder Verzeichnis nicht gefunden)\n", true, false},
		{"socket not reachable", "error connecting to " + existing + " (Permission denied)\n", false, false},
		{"server went away", "server exited unexpectedly\n", true, false},
		{"missing session", "can't find session: work\n", false, true},
		{"missing pane", "can't find pane: %99\n", false, true},
		{"other failure", "command rename-session: unknown flag -d\n", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args := []string{"-S", "/s", "kill-session", "-t", "=work"}
			err := newCommandError(args, errors.New("exit status 1"), tt.stderr)
			if got := errors.Is(err, ErrNoServer); got != tt.noServer {
				t.Errorf("Is(ErrNoServer) = %v, want %v", got, tt.noServer)
			}
			if got := errors.Is(err, ErrNotFound); got != tt.notFound {
				t.Errorf("Is(ErrNotFound) = %v, want %v", got, tt.notFound)
			}
			want := "tmux kill-session: " + strings.TrimSpace(tt.stderr)
			if err.Error() != want {
				t.Errorf("Error() = %q, want %q", err.Error(), want)
			}
			if err.Stderr != strings.TrimSpace(tt.stderr) {
				t.Errorf("Stderr = %q", err.Stderr)
			}
		})
	}
}

func TestCommandErrorText(t *testing.T) {
	args := []string{"list-sessions"}
	tests := []struct {
		name  string
		cause error
		want  string
	}{
		{"timeout", context.DeadlineExceeded, "tmux list-sessions: command timed out"},
		{"canceled", context.Canceled, "tmux list-sessions: command canceled"},
		{"no stderr", errors.New("exit status 1"), "tmux list-sessions: exit status 1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := newCommandError(args, tt.cause, "")
			if err.Error() != tt.want {
				t.Fatalf("Error() = %q, want %q", err.Error(), tt.want)
			}
			if !errors.Is(err, tt.cause) {
				t.Fatalf("errors.Is(err, cause) = false")
			}
		})
	}
}

func TestNoSessionsIsEmpty(t *testing.T) {
	tests := []struct {
		stderr string
		want   bool
	}{
		{"no server running on /x", true},
		{"no sessions", true},
		{"can't find session: x", false},
	}
	for _, tt := range tests {
		err := error(newCommandError([]string{"list-sessions"}, errors.New("exit status 1"), tt.stderr))
		if got := noSessions(err); got != tt.want {
			t.Errorf("noSessions(%q) = %v, want %v", tt.stderr, got, tt.want)
		}
	}
}

func TestInvalidArgumentsNeverRunTmux(t *testing.T) {
	c := New(Options{Launcher: LauncherNone, Logger: quiet})
	c.bin = filepath.Join(t.TempDir(), "not-a-command")
	ctx := context.Background()
	no := false
	calls := map[string]error{
		"KillSession empty":    c.KillSession(ctx, ""),
		"KillSession colon":    c.KillSession(ctx, "work:1"),
		"RenameSession":        c.RenameSession(ctx, "a.b", "c"),
		"RenameSession dollar": c.RenameSession(ctx, "work", "$0"),
		"RenameSession slash":  c.RenameSession(ctx, "work", "pts/3"),
		"RenameSession empty":  c.RenameSession(ctx, "work", ""),
		"CreateSession dollar": second(c.CreateSession(ctx, "$0", "", "")),
		"CreateSession slash":  second(c.CreateSession(ctx, "a/b", "", "")),
		"StepWindow":           c.StepWindow(ctx, "", 1),
		"CreateWindow":         c.CreateWindow(ctx, "", "x"),
		"SelectWindow":         c.SelectWindow(ctx, "=work:1"),
		"KillWindow":           c.KillWindow(ctx, ""),
		"RenameWindow":         c.RenameWindow(ctx, "%1", "x"),
		"SelectLayout preset":  c.SelectLayout(ctx, "work", "-E"),
		"RotateLayout":         c.RotateLayout(ctx, ""),
		"SplitPane direction":  c.SplitPane(ctx, "work", "x"),
		"SelectPane pane":      c.SelectPane(ctx, "work", "=work:"),
		"SelectPane session":   c.SelectPane(ctx, "a:b", "%1"),
		"StepPane":             c.StepPane(ctx, "", 1),
		"ZoomPane no target":   c.ZoomPane(ctx, "", "", nil),
		"ZoomPane bad pane":    c.ZoomPane(ctx, "work", "@1", &no),
		"ResizePane direction": c.ResizePane(ctx, "%1", "X", 1),
		"ResizePane amount":    c.ResizePane(ctx, "%1", "U", 0),
		"KillPane":             c.KillPane(ctx, ""),
		"SwapPane":             c.SwapPane(ctx, "%1", "-t"),
		"SwapPanes pane":       c.SwapPanes(ctx, "=work:", "%1"),
		"SwapPanes target":     c.SwapPanes(ctx, "%1", "@1"),
		"JoinPane pane":        c.JoinPane(ctx, "@1", "@2", "h"),
		"JoinPane window":      c.JoinPane(ctx, "%1", "%2", "h"),
		"JoinPane direction":   c.JoinPane(ctx, "%1", "@2", "-d"),
		"BreakPane session":    c.BreakPane(ctx, "", "%1"),
		"BreakPane pane":       c.BreakPane(ctx, "work", "-d"),
		"SendPrefix":           c.SendPrefix(ctx, ""),
		"SendInterrupt":        c.SendInterrupt(ctx, ""),
		"EnterCopyMode":        c.EnterCopyMode(ctx, ""),
		"ExitCopyMode":         c.ExitCopyMode(ctx, ""),
		"ListPanes window":     second(c.ListPanes(ctx, "work", "%1")),
		"ListPanes session":    second(c.ListPanes(ctx, "", "")),
		"ListWindows":          second(c.ListWindows(ctx, "")),
		"CurrentWindowID":      second(c.CurrentWindowID(ctx, "")),
		"CapturePane":          second(c.CapturePane(ctx, "", CaptureOptions{})),
		"CapturePaneByID":      second(c.CapturePaneByID(ctx, "=work:", CaptureOptions{})),
		"ReadScrollState":      second(c.ReadScrollState(ctx, "")),
		"ScrollHistory":        second(c.ScrollHistory(ctx, "", 1)),
		"ScrollToPosition":     second(c.ScrollToPosition(ctx, "", 1)),
		"CurrentWindowPanes":   third(c.CurrentWindowPanes(ctx, "")),
	}
	for name, err := range calls {
		if !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("%s: err = %v, want ErrInvalidArgument", name, err)
		}
	}
	if c.SessionExists(ctx, "") {
		t.Error("SessionExists(\"\") = true")
	}
}

func second[T any](_ T, err error) error { return err }

func third[A, B any](_ A, _ B, err error) error { return err }
