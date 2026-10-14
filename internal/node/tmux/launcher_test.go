package tmux

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestResolveLauncher(t *testing.T) {
	const cgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmuxde.service\n"
	unit := map[string]string{
		"INVOCATION_ID":   "6c0218f26617454d94cfcd8b85c7e022",
		"XDG_RUNTIME_DIR": "/run/user/1000",
	}
	with := func(base map[string]string, kv ...string) map[string]string {
		env := map[string]string{}
		for k, v := range base {
			env[k] = v
		}
		for i := 0; i < len(kv); i += 2 {
			if kv[i+1] == "" {
				delete(env, kv[i])
			} else {
				env[kv[i]] = kv[i+1]
			}
		}
		return env
	}
	both := []string{"systemd-run", "env"}
	tests := []struct {
		name  string
		mode  Launcher
		env   map[string]string
		found []string
		// want is the mode of the launcher, "" for none.
		want Launcher
		// warn is part of the error that says why auto runs plainly.
		warn string
		// fails is part of the launcher error for a mode asked by name.
		fails string
	}{
		{name: "none in a unit", mode: LauncherNone, env: unit, found: both},
		{name: "auto outside a unit", mode: LauncherAuto, env: with(unit, "INVOCATION_ID", ""), found: both},
		{name: "empty is auto outside a unit", env: with(unit, "INVOCATION_ID", ""), found: both},
		{name: "auto in a unit", mode: LauncherAuto, env: unit, found: both, want: LauncherAuto},
		{name: "empty is auto in a unit", env: unit, found: both, want: LauncherAuto},
		{name: "auto with only a bus address", mode: LauncherAuto, found: both, want: LauncherAuto,
			env: with(unit, "XDG_RUNTIME_DIR", "", "DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus")},
		{name: "auto without a user bus", mode: LauncherAuto, env: with(unit, "XDG_RUNTIME_DIR", ""), found: both,
			warn: "cannot reach the user manager"},
		{name: "auto without systemd-run", mode: LauncherAuto, env: unit, found: []string{"env"}, warn: "systemd-run"},
		{name: "auto without env", mode: LauncherAuto, env: unit, found: []string{"systemd-run"}, warn: "env"},
		{name: "systemd-run outside a unit", mode: LauncherSystemdRun, env: with(unit, "INVOCATION_ID", ""), found: both,
			want: LauncherSystemdRun},
		{name: "systemd-run missing", mode: LauncherSystemdRun, env: unit, found: []string{"env"},
			want: LauncherSystemdRun, fails: "systemd-run"},
		{name: "systemd-run without a user bus", mode: LauncherSystemdRun, env: with(unit, "XDG_RUNTIME_DIR", ""), found: both,
			want: LauncherSystemdRun, fails: "cannot reach the user manager"},
		{name: "unknown", mode: "systemd", env: unit, found: both, want: "systemd", fails: "unknown launcher"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			getenv := func(k string) string { return tt.env[k] }
			lookPath := func(name string) (string, error) {
				if slices.Contains(tt.found, name) {
					return "/usr/bin/" + name, nil
				}
				return "", &exec.Error{Name: name, Err: exec.ErrNotFound}
			}
			l, err := resolveLauncher(tt.mode, getenv, lookPath, cgroup)
			if tt.warn != "" {
				if l != nil || err == nil || !strings.Contains(err.Error(), tt.warn) {
					t.Fatalf("got %+v, %v, want nil and an error about %q", l, err, tt.warn)
				}
				return
			}
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if tt.want == "" {
				if l != nil {
					t.Fatalf("launcher %+v, want none", l)
				}
				return
			}
			if l == nil || l.mode != tt.want {
				t.Fatalf("launcher %+v, want mode %q", l, tt.want)
			}
			if tt.fails != "" {
				if l.err == nil || !strings.Contains(l.err.Error(), tt.fails) {
					t.Fatalf("launcher err = %v, want one about %q", l.err, tt.fails)
				}
				return
			}
			if l.err != nil || l.systemdRun != "/usr/bin/systemd-run" || l.env != "/usr/bin/env" || l.prefix != "tmuxde" {
				t.Fatalf("launcher %+v", l)
			}
		})
	}
}

func TestScopePrefix(t *testing.T) {
	tests := []struct{ cgroup, want string }{
		{"0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmuxde.service\n", "tmuxde"},
		{"0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmuxde-spike-a.service\n", "tmuxde-spike-a"},
		{"0::/system.slice/tmuxde.dev_2.service", "tmuxde.dev_2"},
		// cgroup v1 with the systemd hierarchy.
		{"12:cpu,cpuacct:/\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/dev.service\n", "dev"},
		{"0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1.scope\n", "tmuxde"},
		{"0::/user.slice/user-1000.slice/session-7.scope\n", "tmuxde"},
		{"0::/system.slice/tmuxde@main.service\n", "tmuxde"},
		{`0::/system.slice/tmuxde\x2ddev.service`, "tmuxde"},
		{"0::/.service\n", "tmuxde"},
		{"0::/\n", "tmuxde"},
		{"", "tmuxde"},
	}
	for _, tt := range tests {
		if got := scopePrefix(tt.cgroup); got != tt.want {
			t.Errorf("scopePrefix(%q) = %q, want %q", tt.cgroup, got, tt.want)
		}
	}
}

// TestCommandEnvDropsUnitVariables checks the environment a tmux server
// started by tmuxde gets: none of the unit's variables, none of the
// tmuxde settings from the env file, everything a shell needs.
func TestCommandEnvDropsUnitVariables(t *testing.T) {
	keep := []string{
		"PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin", "HOME=/home/u", "SHELL=/bin/bash",
		"LANG=en_US.UTF-8", "TERM=xterm-256color", "XDG_RUNTIME_DIR=/run/user/1000",
		"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", "USER=u", "LOGNAME=u",
		"TMUX_TMPDIR=/run/user/1000",
	}
	// Every setting the spike pane showed, the env file can hold or the
	// server reads.
	settings := []string{
		"AUTH_TOKEN", "ALLOWED_PATHS", "CORS_ORIGINS", "STT_SOCKET", "TMUX_SOCKET",
		"TMUX_DEFAULT_SHELL", "IDLE_TIMEOUT_MINUTES", "TMUXDE_LISTEN", "TMUXDE_CONFIG_DIR",
		"TMUXDE_TMUX_LAUNCHER", "TMUXDE_DEV_WEB_URL",
	}
	var in []string
	for _, k := range append(slices.Clone(unitEnv), settings...) {
		in = append(in, k+"=x")
	}
	in = append(in, keep...)
	if got := commandEnv(in); !reflect.DeepEqual(got, keep) {
		t.Fatalf("commandEnv = %q, want %q", got, keep)
	}
}

// launchFakes is a fake tmux and a fake systemd-run in a temp dir.
//
// The fake tmux answers -N -V with exit 0, or 1 when noN is set. A create
// with -N fails as tmux does without a server until a create without -N
// ran. Every call appends its argv, one argument per line and a "--end"
// line, to tmux.argv, and its environment to tmux.env.
//
// The fake systemd-run answers --help with or without
// --expand-environment. Otherwise it records its argv and environment,
// sets INVOCATION_ID as the real one does for a scope, and runs everything
// after "--".
type launchFakes struct {
	dir, tmux, systemdRun, env string
}

func newLaunchFakes(t *testing.T, noN, oldSystemd bool) *launchFakes {
	t.Helper()
	envPath, err := exec.LookPath("env")
	if err != nil {
		t.Skipf("env not installed: %v", err)
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &launchFakes{dir: dir, env: envPath}
	nv := "0"
	if noN {
		nv = "1"
	}
	f.tmux = filepath.Join(dir, "tmux")
	tmux := `#!/bin/sh
d='` + dir + `'
for a in "$@"; do printf '%s\n' "$a"; done >> "$d/tmux.argv"
echo --end >> "$d/tmux.argv"
env >> "$d/tmux.env"
echo --end >> "$d/tmux.env"
if [ "$1" = -N ] && [ "$2" = -V ]; then
	[ ` + nv + ` = 0 ] && echo 'tmux 3.7c' && exit 0
	echo 'tmux: unknown option -- N' >&2
	exit 1
fi
if [ "$1" = -N ] && [ ! -e "$d/running" ]; then
	echo 'no server running on /tmp/tmux-1000/default' >&2
	exit 1
fi
touch "$d/running"
printf 'w\t$7\n'
`
	help := "  --expand-environment=BOOL    Control expansion of environment variables"
	if oldSystemd {
		help = "  --scope                      Run this as scope rather than service"
	}
	f.systemdRun = filepath.Join(dir, "systemd-run")
	sr := `#!/bin/sh
d='` + dir + `'
if [ "$1" = --help ]; then
	echo '` + help + `'
	exit 0
fi
for a in "$@"; do printf '%s\n' "$a"; done >> "$d/systemd-run.argv"
echo --end >> "$d/systemd-run.argv"
env > "$d/systemd-run.env"
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
shift
INVOCATION_ID=scope-id exec "$@"
`
	for path, body := range map[string]string{f.tmux: tmux, f.systemdRun: sr} {
		if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

// calls returns the argv of every call recorded in name.
func (f *launchFakes) calls(t *testing.T, name string) [][]string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	var cur []string
	for line := range strings.Lines(string(b)) {
		line = strings.TrimSuffix(line, "\n")
		if line == "--end" {
			calls = append(calls, cur)
			cur = nil
			continue
		}
		cur = append(cur, line)
	}
	return calls
}

// client returns a client that runs the fake tmux and the fake
// systemd-run in mode, logging to log.
func (f *launchFakes) client(t *testing.T, mode Launcher, log *strings.Builder) *Client {
	t.Helper()
	c := fakeClient(t, "sh", Options{Socket: "/run/test/tmux.sock"})
	c.bin = f.tmux
	c.log = slogTo(log)
	// What a unit hands tmuxde, as commandEnv leaves it.
	c.env = commandEnv([]string{
		"PATH=" + os.Getenv("PATH"), "HOME=/home/u", "SHELL=/bin/bash", "LANG=C.UTF-8",
		"XDG_RUNTIME_DIR=/run/user/1000", "INVOCATION_ID=unit-id", "JOURNAL_STREAM=8:123",
		"SYSTEMD_EXEC_PID=42", "MANAGERPID=7",
	})
	c.launch = &launcher{mode: mode, systemdRun: f.systemdRun, env: f.env, prefix: "tmuxde"}
	return c
}

// TestLauncherStartsServerInScope checks the first new-session without a
// server: -N first, then the same argv through systemd-run, and the
// second one with a server plainly with -N. A name with a dash and a
// command with "$" reach tmux unchanged.
func TestLauncherStartsServerInScope(t *testing.T) {
	f := newLaunchFakes(t, false, false)
	var log strings.Builder
	c := f.client(t, LauncherAuto, &log)

	const name, command = "-dash $HOME", `echo "$HOME"; exec sleep 600`
	info, err := c.CreateSession(bg, name, "", command)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if info.Name != "w" || info.ID != "$7" {
		t.Fatalf("created %+v, want the output of the launched tmux", info)
	}
	create := []string{"-S", "/run/test/tmux.sock", "new-session", "-d", "-P", "-F", createFormat, "-s", name, "--", command}
	wantTmux := [][]string{
		{"-N", "-V"},
		append([]string{"-N"}, create...),
		create,
	}
	if got := f.calls(t, "tmux.argv"); !reflect.DeepEqual(got, wantTmux) {
		t.Fatalf("tmux calls\n%q\nwant\n%q", got, wantTmux)
	}
	sr := f.calls(t, "systemd-run.argv")
	if len(sr) != 1 {
		t.Fatalf("systemd-run calls %q, want one", sr)
	}
	unit := regexp.MustCompile(`^--unit=(tmuxde-tmux-[0-9a-f]{8})$`).FindStringSubmatch(sr[0][4])
	if unit == nil {
		t.Fatalf("unit flag %q", sr[0][4])
	}
	wantSR := append([]string{
		"--user", "--scope", "--collect", "--quiet", sr[0][4],
		"--description=tmux server started by tmuxde", "--expand-environment=no", "--",
		f.env, "-u", "INVOCATION_ID", f.tmux,
	}, create...)
	if !reflect.DeepEqual(sr[0], wantSR) {
		t.Fatalf("systemd-run argv\n%q\nwant\n%q", sr[0], wantSR)
	}

	// systemd-run gets the unit's environment without the unit's own
	// variables, and env drops the INVOCATION_ID systemd-run set.
	srEnv := readFile(t, filepath.Join(f.dir, "systemd-run.env"))
	tmuxEnv := strings.Split(readFile(t, filepath.Join(f.dir, "tmux.env")), "--end\n")[2]
	for label, env := range map[string]string{"systemd-run": srEnv, "launched tmux": tmuxEnv} {
		for _, k := range []string{"INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "MANAGERPID"} {
			if hasVar(env, k) {
				t.Errorf("%s environment has %s:\n%s", label, k, env)
			}
		}
		for _, k := range []string{"PATH", "HOME", "SHELL", "LANG", "XDG_RUNTIME_DIR"} {
			if !hasVar(env, k) {
				t.Errorf("%s environment lacks %s:\n%s", label, k, env)
			}
		}
	}

	if n := strings.Count(log.String(), `msg="starting tmux server in its own scope"`); n != 1 {
		t.Fatalf("launch logged %d times, want once:\n%s", n, log.String())
	}
	if !strings.Contains(log.String(), "level=INFO") || !strings.Contains(log.String(), "unit="+unit[1]+".scope") {
		t.Fatalf("launch log %q, want INFO with unit %s.scope", log.String(), unit[1])
	}

	// A server runs now. The next session needs no launcher.
	if _, err := c.CreateSession(bg, "second", "", ""); err != nil {
		t.Fatal(err)
	}
	calls := f.calls(t, "tmux.argv")
	wantLast := []string{"-N", "-S", "/run/test/tmux.sock", "new-session", "-d", "-P", "-F", createFormat, "-s", "second"}
	if len(calls) != 4 || !reflect.DeepEqual(calls[3], wantLast) {
		t.Fatalf("tmux calls after the start %q, want one more: %q", calls[3:], wantLast)
	}
	if n := len(f.calls(t, "systemd-run.argv")); n != 1 {
		t.Fatalf("systemd-run ran %d times, want once", n)
	}
	if strings.Count(log.String(), "starting tmux server") != 1 {
		t.Fatalf("second session logged a launch:\n%s", log.String())
	}
}

// TestLauncherWithoutNoStartFlag checks tmux before 3.2: without -N every
// new-session goes through systemd-run, which is fine with a running
// server too.
func TestLauncherWithoutNoStartFlag(t *testing.T) {
	f := newLaunchFakes(t, true, false)
	var log strings.Builder
	c := f.client(t, LauncherAuto, &log)
	for _, name := range []string{"one", "two"} {
		if _, err := c.CreateSession(bg, name, "", ""); err != nil {
			t.Fatal(err)
		}
	}
	for _, call := range f.calls(t, "tmux.argv")[1:] {
		if slices.Contains(call, "-N") {
			t.Fatalf("tmux got -N after it refused it: %q", call)
		}
	}
	if n := len(f.calls(t, "systemd-run.argv")); n != 2 {
		t.Fatalf("systemd-run ran %d times, want twice", n)
	}
	// The refusal is cached: one probe for two sessions.
	if n := len(f.calls(t, "tmux.argv")); n != 3 {
		t.Fatalf("tmux ran %d times, want 3", n)
	}
}

// TestLauncherOldSystemd checks a systemd-run without
// --expand-environment: auto starts the server plainly with a warning,
// systemd-run by name fails and starts nothing.
func TestLauncherOldSystemd(t *testing.T) {
	t.Run("auto", func(t *testing.T) {
		f := newLaunchFakes(t, false, true)
		var log strings.Builder
		c := f.client(t, LauncherAuto, &log)
		if _, err := c.CreateSession(bg, "w", "", ""); err != nil {
			t.Fatal(err)
		}
		calls := f.calls(t, "tmux.argv")
		want := []string{"-S", "/run/test/tmux.sock", "new-session", "-d", "-P", "-F", createFormat, "-s", "w"}
		if len(calls) != 3 || !reflect.DeepEqual(calls[2], want) {
			t.Fatalf("tmux calls %q, want a plain create last", calls)
		}
		if f.calls(t, "systemd-run.argv") != nil {
			t.Fatal("systemd-run ran a command")
		}
		if !strings.Contains(log.String(), "level=WARN") || !strings.Contains(log.String(), "--expand-environment") {
			t.Fatalf("log %q, want a warning that names --expand-environment", log.String())
		}
	})
	t.Run("systemd-run", func(t *testing.T) {
		f := newLaunchFakes(t, false, true)
		var log strings.Builder
		c := f.client(t, LauncherSystemdRun, &log)
		_, err := c.CreateSession(bg, "w", "", "")
		if err == nil || !strings.Contains(err.Error(), "systemd 254") {
			t.Fatalf("err = %v, want one about systemd 254", err)
		}
		if n := len(f.calls(t, "tmux.argv")); n != 2 {
			t.Fatalf("tmux ran %d times, want the -N probe and the -N create only", n)
		}
	})
}

// TestLauncherBrokenByName checks systemd-run asked for by name but not
// usable: a start fails with the reason, a session on a running server
// still works.
func TestLauncherBrokenByName(t *testing.T) {
	f := newLaunchFakes(t, false, false)
	var log strings.Builder
	c := f.client(t, LauncherSystemdRun, &log)
	missing := &exec.Error{Name: "systemd-run", Err: exec.ErrNotFound}
	c.launch = &launcher{mode: LauncherSystemdRun, err: missing}
	if _, err := c.CreateSession(bg, "w", "", ""); !errors.Is(err, exec.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if err := os.WriteFile(filepath.Join(f.dir, "running"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CreateSession(bg, "w", "", ""); err != nil {
		t.Fatalf("create with a running server: %v", err)
	}
}

// TestLauncherKeepsCreateErrors checks that a tmux error other than no
// server comes back from the -N create as it is, without a launch.
func TestLauncherKeepsCreateErrors(t *testing.T) {
	f := newLaunchFakes(t, false, false)
	var log strings.Builder
	c := f.client(t, LauncherAuto, &log)
	c.bin = writeScript(t, `[ "$2" = -V ] && exit 0
echo 'duplicate session: w' >&2
exit 1`)
	_, err := c.CreateSession(bg, "w", "", "")
	if err == nil || err.Error() != "tmux new-session: duplicate session: w" {
		t.Fatalf("err = %v", err)
	}
	if f.calls(t, "systemd-run.argv") != nil {
		t.Fatal("systemd-run ran")
	}
}

// TestNewResolvesLauncher checks the wiring in New: the process
// environment and PATH decide, and none or no unit means no launcher.
func TestNewResolvesLauncher(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"systemd-run", "env"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1000")
	t.Setenv("INVOCATION_ID", "unit-id")
	c := New(Options{Logger: quiet})
	if c.launch == nil || c.launch.systemdRun != filepath.Join(dir, "systemd-run") || c.launch.env != filepath.Join(dir, "env") {
		t.Fatalf("launcher %+v", c.launch)
	}
	if slices.ContainsFunc(c.env, func(kv string) bool { return strings.HasPrefix(kv, "INVOCATION_ID=") }) {
		t.Fatal("tmux environment keeps INVOCATION_ID")
	}
	if c := New(Options{Launcher: LauncherNone, Logger: quiet}); c.launch != nil {
		t.Fatalf("none gave launcher %+v", c.launch)
	}
	t.Setenv("INVOCATION_ID", "")
	if c := New(Options{Logger: quiet}); c.launch != nil {
		t.Fatalf("auto outside a unit gave launcher %+v", c.launch)
	}
}

// TestNoLauncherRunsPlainly checks that a client without a launcher never
// passes -N, so tmux before 3.2 keeps working.
func TestNoLauncherRunsPlainly(t *testing.T) {
	f := newLaunchFakes(t, false, false)
	var log strings.Builder
	c := f.client(t, LauncherNone, &log)
	c.launch = nil
	if _, err := c.CreateSession(bg, "w", "", ""); err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"-S", "/run/test/tmux.sock", "new-session", "-d", "-P", "-F", createFormat, "-s", "w"}}
	if got := f.calls(t, "tmux.argv"); !reflect.DeepEqual(got, want) {
		t.Fatalf("tmux calls %q, want %q", got, want)
	}
}

func hasVar(env, name string) bool {
	for line := range strings.Lines(env) {
		if strings.HasPrefix(line, name+"=") {
			return true
		}
	}
	return false
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// slogTo logs every level as text to w.
func slogTo(w io.Writer) *slog.Logger {
	return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelDebug}))
}
