package tmux

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

var quiet = slog.New(slog.DiscardHandler)

// fakeClient runs bin instead of tmux. Socket stays empty, so argv reaches
// bin as given. The launcher is off unless opts names one, so a test run
// inside a systemd unit sees the same argv.
func fakeClient(t *testing.T, bin string, opts Options) *Client {
	t.Helper()
	path, err := exec.LookPath(bin)
	if err != nil {
		t.Skipf("%s not installed", bin)
	}
	if opts.Launcher == "" {
		opts.Launcher = LauncherNone
	}
	opts.Logger = quiet
	c := New(opts)
	c.bin = path
	return c
}

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

func TestExecReportsExitAndStderr(t *testing.T) {
	c := fakeClient(t, "sh", Options{})
	_, err := c.run(context.Background(), "-c", "echo 'no server running on /x' >&2; exit 3")
	var ce *CommandError
	if !errors.As(err, &ce) {
		t.Fatalf("err = %v, want *CommandError", err)
	}
	if ce.ExitCode != 3 || ce.Stderr != "no server running on /x" {
		t.Fatalf("ExitCode %d, Stderr %q", ce.ExitCode, ce.Stderr)
	}
	if !errors.Is(err, ErrNoServer) {
		t.Fatal("not ErrNoServer")
	}
	if want := "tmux -c: no server running on /x"; err.Error() != want {
		t.Fatalf("Error() = %q, want %q", err.Error(), want)
	}
}

func TestExecTimesOut(t *testing.T) {
	c := fakeClient(t, "sleep", Options{Timeout: 50 * time.Millisecond})
	start := time.Now()
	_, err := c.run(context.Background(), "5")
	if err == nil {
		t.Fatal("no error")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want DeadlineExceeded", err)
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("Error() = %q, want it to say timed out", err.Error())
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("took %v", d)
	}
}

func TestExecHonoursCallerContext(t *testing.T) {
	c := fakeClient(t, "sleep", Options{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := c.run(ctx, "5")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want Canceled", err)
	}
}

func TestExecCutsOutputAtMaxOutput(t *testing.T) {
	c := fakeClient(t, "head", Options{MaxOutput: 1000})
	out, cut, err := c.exec(context.Background(), []string{"-c", "100000", "/dev/zero"})
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if !cut || len(out) != 1000 {
		t.Fatalf("cut %v, len %d, want cut and 1000", cut, len(out))
	}

	out, cut, err = c.exec(context.Background(), []string{"-c", "1000", "/dev/zero"})
	if err != nil || cut || len(out) != 1000 {
		t.Fatalf("exact fit: cut %v, len %d, err %v", cut, len(out), err)
	}
}

func TestCaptureCutEndsAtALine(t *testing.T) {
	// The fake prints four lines. The cap falls inside the third.
	c := fakeClient(t, "sh", Options{MaxOutput: 25})
	c.bin = writeScript(t, "printf 'line one\\nline two\\nline three\\nline four\\n'")
	out, err := c.capture(context.Background(), "%1", CaptureOptions{})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if out != "line one\nline two\n" {
		t.Fatalf("capture = %q", out)
	}
}

func TestSelectPaneProbeCachesOnlyAnswers(t *testing.T) {
	c := fakeClient(t, "sh", Options{})
	c.bin = writeScript(t, "exit 1")
	if c.selectPaneZ(context.Background()) {
		t.Fatal("failed probe said yes")
	}
	c.bin = writeScript(t, "echo 'select-pane (selectp) [-DdeLlMmRUZ] [-T title] [-t target-pane]'")
	if !c.selectPaneZ(context.Background()) {
		t.Fatal("probe after a failure was not asked again")
	}
	c.bin = writeScript(t, "exit 1")
	if !c.selectPaneZ(context.Background()) {
		t.Fatal("answer was not cached")
	}
}

func TestInvalidArgumentsNeverRunTmux(t *testing.T) {
	c := fakeClient(t, "sh", Options{})
	marker := filepath.Join(t.TempDir(), "ran")
	c.bin = writeScript(t, "touch "+marker)
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
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("tmux ran for an invalid argument")
	}
}

// TestNewCommandArgs checks the command new-session and new-window get.
// With no DefaultShell and no command tmux gets none and applies its own
// default-command and default-shell options.
func TestNewCommandArgs(t *testing.T) {
	create := []string{"new-session", "-d", "-P", "-F", createFormat, "-s", "w"}
	window := []string{"new-window", "-t", "=w:", "-n", "x"}
	tests := []struct {
		name, shell, command string
		window               bool
		want                 []string
	}{
		{name: "session no shell", want: create},
		{name: "session no shell with command", command: "htop", want: append(slices.Clip(create), "--", "htop")},
		{name: "session shell", shell: "/bin/zsh", want: append(slices.Clip(create), "--", "/bin/zsh")},
		{name: "session shell with command", shell: "/bin/zsh", command: "-x", want: append(slices.Clip(create), "--", "-x")},
		{name: "window no shell", window: true, want: window},
		{name: "window shell", shell: "/bin/zsh", window: true, want: append(slices.Clip(window), "--", "/bin/zsh")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := fakeClient(t, "sh", Options{DefaultShell: tt.shell})
			argv := filepath.Join(t.TempDir(), "argv")
			c.bin = writeScript(t, `printf '%s\n' "$@" > '`+argv+`'
printf 'w\t$1\n'`)
			var err error
			if tt.window {
				err = c.CreateWindow(context.Background(), "w", "x")
			} else {
				_, err = c.CreateSession(context.Background(), "w", "", tt.command)
			}
			if err != nil {
				t.Fatal(err)
			}
			b, err := os.ReadFile(argv)
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Split(strings.TrimSuffix(string(b), "\n"), "\n"); !slices.Equal(got, tt.want) {
				t.Fatalf("argv %q, want %q", got, tt.want)
			}
		})
	}
}

// TestWorkDir checks the folder tmux runs in: Options.Dir when it is a
// directory, else HOME, else /. Never the folder of the process.
func TestWorkDir(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "dir")
	home := filepath.Join(base, "home")
	file := filepath.Join(base, "file")
	for _, d := range []string{dir, home} {
		if err := os.Mkdir(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(base, "missing")
	tests := []struct {
		name, dir, home, want string
	}{
		{name: "dir", dir: dir, home: home, want: dir},
		{name: "dir cleaned", dir: dir + "/./", home: home, want: dir},
		{name: "empty uses home", home: home, want: home},
		{name: "missing uses home", dir: missing, home: home, want: home},
		{name: "file uses home", dir: file, home: home, want: home},
		{name: "relative uses home", dir: "dir", home: home, want: home},
		{name: "no home", dir: missing, home: missing, want: "/"},
		{name: "relative home", home: "home", want: "/"},
		{name: "empty home", want: "/"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("HOME", tt.home)
			// A relative Dir or HOME must not resolve against the process
			// folder.
			t.Chdir(base)
			if got := New(Options{Dir: tt.dir, Logger: quiet}).opts.Dir; got != tt.want {
				t.Fatalf("Dir %q with HOME %q runs tmux in %q, want %q", tt.dir, tt.home, got, tt.want)
			}
		})
	}

	// Every call runs there, whatever the process folder is.
	t.Chdir(base)
	c := fakeClient(t, "sh", Options{Dir: dir})
	c.bin = writeScript(t, "pwd")
	out, err := c.run(context.Background(), "list-sessions")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(out); got != dir {
		t.Fatalf("tmux ran in %q, want %q", got, dir)
	}
}

// TestListFailureLevel checks the level of a failed window or pane
// listing. A session that is gone is no error for the log: the monitor
// polls a renamed session every second while a browser shows the old name.
func TestListFailureLevel(t *testing.T) {
	tests := []struct {
		name, stderr string
		want         slog.Level
	}{
		{"missing session", "can't find session: work", slog.LevelDebug},
		{"missing window", "can't find window: @9", slog.LevelDebug},
		{"other failure", "server exited unexpectedly", slog.LevelError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := fakeClient(t, "sh", Options{})
			c.bin = writeScript(t, `echo "`+tt.stderr+`" >&2`+"\nexit 1")
			for _, call := range []struct {
				msg string
				run func() error
			}{
				{"list windows failed", func() error { return second(c.ListWindows(context.Background(), "work")) }},
				{"list panes failed", func() error { return second(c.ListPanes(context.Background(), "work", "")) }},
			} {
				var buf strings.Builder
				c.log = slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
				if err := call.run(); err == nil {
					t.Fatalf("%s: no error", call.msg)
				}
				want := "level=" + tt.want.String() + " msg=\"" + call.msg + "\""
				if !strings.Contains(buf.String(), want) {
					t.Fatalf("log %q, want %s", buf.String(), want)
				}
			}
		})
	}
}

func second[T any](_ T, err error) error { return err }

func third[A, B any](_ A, _ B, err error) error { return err }

// writeScript writes an executable sh script and returns its path.
func writeScript(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-tmux")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}
