package tmux

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// Launcher says how new-session starts a tmux server when none runs.
//
// tmux starts its server from the client of the first command that needs
// one. The server stays in the process tree and the cgroup of that client.
// Under a systemd unit every stop or restart of the unit then kills the
// server and every session in it. Every pane also inherits the unit's
// environment.
//
// With systemd-run that first new-session runs as
//
//	systemd-run --user --scope --collect --quiet --unit=<name> \
//	    --description=... --expand-environment=no -- \
//	    /usr/bin/env -u INVOCATION_ID /path/to/tmux [-S socket] new-session ...
//
// systemd-run moves itself into a new scope of the user manager and runs
// env, which runs tmux. tmux forks the server inside that scope. Stopping
// the tmuxde unit leaves the scope alone. stdout, stderr, the exit status,
// the working folder and the environment pass through as they are.
// systemd-run expands $VAR in the command line by default, for a scope as
// well. --expand-environment=no keeps a "$" in a name, folder or command.
// systemd-run sets INVOCATION_ID to the id of the new scope, so env drops
// it again.
//
// The scope is still started from the tmuxde process. So the server and
// every pane keep the process attributes of the unit: no_new_privs,
// resource limits, namespaces, umask. Only the cgroup changes. The unit
// must not set NoNewPrivileges= or sandboxing options, or sudo in a pane
// stops working.
//
// Only a start goes through systemd-run. new-session first runs with -N,
// which never starts a server. When that finds no server, the launcher
// runs the same command without -N. A server that appeared in between
// takes the session as usual, and the scope ends with the tmux client.
// tmux before 3.2 has no -N. There every new-session goes through the
// launcher, which works the same with a running server.
type Launcher string

const (
	// LauncherAuto uses systemd-run when tmuxde runs in a systemd unit:
	// INVOCATION_ID is set, XDG_RUNTIME_DIR or DBUS_SESSION_BUS_ADDRESS
	// is set, and systemd-run and env are on PATH. Otherwise, or when
	// systemd-run turns out too old, tmux runs plainly with a warning.
	// The default.
	LauncherAuto Launcher = "auto"
	// LauncherSystemdRun always uses systemd-run. When it cannot run,
	// creating a session while no server runs fails.
	LauncherSystemdRun Launcher = "systemd-run"
	// LauncherNone never uses systemd-run. The tmux server becomes a
	// child of tmuxde.
	LauncherNone Launcher = "none"
)

// unitEnv are variables systemd sets for the processes of one unit. They
// describe the tmuxde unit, not a pane, so commandEnv drops them from
// every tmux call. The first seven show up in a user service with default
// settings. The others come with settings such as Type=notify,
// WatchdogSec=, socket activation, StateDirectory= or LoadCredential=.
var unitEnv = []string{
	"INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "MANAGERPID", "MANAGERPIDFDID",
	"MEMORY_PRESSURE_WATCH", "MEMORY_PRESSURE_WRITE",
	"NOTIFY_SOCKET", "WATCHDOG_PID", "WATCHDOG_USEC",
	"LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES",
	"RUNTIME_DIRECTORY", "STATE_DIRECTORY", "CACHE_DIRECTORY", "LOGS_DIRECTORY",
	"CONFIGURATION_DIRECTORY", "CREDENTIALS_DIRECTORY",
}

// launcher runs new-session through systemd-run. See Launcher.
type launcher struct {
	mode Launcher
	// systemdRun and env are absolute paths.
	systemdRun, env string
	// prefix starts every scope name. See scopePrefix.
	prefix string
	// err is why the launcher cannot run. Only set when systemd-run was
	// asked for by name. Starting a server then fails with it.
	err error

	// mu guards the systemd-run --help probe. Only a probe that found
	// --expand-environment is cached.
	mu    sync.Mutex
	ready bool
}

// newLauncher resolves mode against the process environment and PATH and
// logs why systemd-run is not used when that is a surprise. Nil means
// new-session runs plainly.
func newLauncher(mode Launcher, log *slog.Logger) *launcher {
	cgroup, _ := os.ReadFile("/proc/self/cgroup")
	l, err := resolveLauncher(mode, os.Getenv, exec.LookPath, string(cgroup))
	switch {
	case l != nil && l.err != nil:
		log.Error("tmux launcher not usable, creating a session fails while no tmux server runs",
			"launcher", string(l.mode), "error", l.err)
	case err != nil:
		log.Warn("tmux launcher not usable, a tmux server started by tmuxde stops with its unit",
			"launcher", string(LauncherAuto), "reason", err)
	}
	return l
}

// resolveLauncher decides whether new-session goes through systemd-run.
// getenv reads the environment tmuxde started with, before commandEnv
// drops anything. lookPath finds programs. cgroup is /proc/self/cgroup.
//
// It returns nil when tmux runs plainly. In auto mode a non nil error
// says why systemd-run is not used although tmuxde runs in a unit. When
// systemd-run is asked for by name and cannot run, the launcher carries
// the reason in err instead.
func resolveLauncher(mode Launcher, getenv func(string) string, lookPath func(string) (string, error), cgroup string) (*launcher, error) {
	switch mode {
	case LauncherNone:
		return nil, nil
	case "", LauncherAuto:
		if getenv("INVOCATION_ID") == "" {
			return nil, nil
		}
		mode = LauncherAuto
	case LauncherSystemdRun:
	default:
		return &launcher{mode: mode, err: fmt.Errorf("unknown launcher %q, want auto, systemd-run or none", mode)}, nil
	}
	l := &launcher{mode: mode, prefix: scopePrefix(cgroup)}
	var err error
	if getenv("XDG_RUNTIME_DIR") == "" && getenv("DBUS_SESSION_BUS_ADDRESS") == "" {
		err = errors.New("XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS are unset, so systemd-run cannot reach the user manager")
	}
	if err == nil {
		l.systemdRun, err = lookPath("systemd-run")
	}
	if err == nil {
		l.env, err = lookPath("env")
	}
	switch {
	case err == nil:
		return l, nil
	case mode == LauncherAuto:
		return nil, err
	}
	l.err = err
	return l, nil
}

// scopePrefix names scopes after the service tmuxde runs in, so
// tmuxde.service starts tmuxde-tmux-<random>.scope. cgroup is the text of
// /proc/self/cgroup. Anything but a plain service name gives "tmuxde".
func scopePrefix(cgroup string) string {
	for line := range strings.Lines(cgroup) {
		// "0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmuxde.service"
		parts := strings.SplitN(strings.TrimSpace(line), ":", 3)
		if len(parts) != 3 {
			continue
		}
		unit := parts[2][strings.LastIndex(parts[2], "/")+1:]
		if name, ok := strings.CutSuffix(unit, ".service"); ok && plainUnitName(name) {
			return name
		}
	}
	return "tmuxde"
}

// plainUnitName accepts the characters systemd allows in a unit name,
// without "@" (a template instance) and "\" (an escape).
func plainUnitName(name string) bool {
	if name == "" {
		return false
	}
	for _, r := range name {
		ok := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' ||
			r == ':' || r == '_' || r == '.' || r == '-'
		if !ok {
			return false
		}
	}
	return true
}

// unitName returns a scope name that no earlier start used. A scope stays
// as long as anything runs in it, such as a process a pane left behind
// after its server ended, so a fixed name could clash.
func (l *launcher) unitName() string {
	var b [4]byte
	// crypto/rand.Read never fails.
	_, _ = rand.Read(b[:])
	return l.prefix + "-tmux-" + hex.EncodeToString(b[:])
}

// argv is the systemd-run command line for tmux with tmuxArgs. tmux is an
// absolute path. tmuxArgs reach tmux unchanged.
func (l *launcher) argv(unit, tmux string, tmuxArgs []string) []string {
	argv := []string{
		"--user", "--scope", "--collect", "--quiet",
		"--unit=" + unit,
		"--description=tmux server started by " + l.prefix,
		"--expand-environment=no",
		"--",
		l.env, "-u", "INVOCATION_ID", tmux,
	}
	return append(argv, tmuxArgs...)
}

// create runs new-session with args and returns its stdout. Without a
// launcher it runs plainly. With one it runs with -N first and through
// systemd-run when no server answers, see Launcher. In auto mode a
// launcher that cannot run falls back to a plain start and logs a warning.
// Asked for by name, it fails instead.
func (c *Client) create(ctx context.Context, args []string) (string, error) {
	l := c.launch
	if l == nil {
		return c.run(ctx, args...)
	}
	tmuxArgs := c.withSocket(args)
	if c.NoStartFlag(ctx) {
		out, _, err := c.exec(ctx, append([]string{"-N"}, tmuxArgs...))
		if !errors.Is(err, ErrNoServer) {
			return out, err
		}
	}
	argv, unit, err := c.launchArgv(ctx, tmuxArgs)
	if err != nil {
		if l.mode != LauncherAuto {
			return "", fmt.Errorf("tmux: start server through systemd-run: %w", err)
		}
		c.log.Warn("tmux launcher not usable, starting the tmux server as a child of tmuxde", "error", err)
		out, _, err := c.exec(ctx, tmuxArgs)
		return out, err
	}
	c.log.Info("starting tmux server in its own scope", "launcher", string(LauncherSystemdRun), "unit", unit+".scope")
	out, _, err := c.execProgram(ctx, l.systemdRun, argv, tmuxArgs)
	return out, err
}

// launchArgv checks that the launcher can run and returns its command
// line for tmuxArgs and the scope name.
func (c *Client) launchArgv(ctx context.Context, tmuxArgs []string) ([]string, string, error) {
	l := c.launch
	if l.err != nil {
		return nil, "", l.err
	}
	if err := c.systemdRunReady(ctx); err != nil {
		return nil, "", err
	}
	tmux, err := exec.LookPath(c.bin)
	if err != nil {
		return nil, "", err
	}
	unit := l.unitName()
	return l.argv(unit, tmux, tmuxArgs), unit, nil
}

// systemdRunReady checks once that systemd-run knows
// --expand-environment, which systemd 254 added. Without it nothing
// guarantees that a "$" in a session name, folder or command stays as it
// is, so the launcher is not used.
func (c *Client) systemdRunReady(ctx context.Context) error {
	l := c.launch
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ready {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, c.opts.Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, l.systemdRun, "--help")
	cmd.Dir = c.opts.Dir
	cmd.Env = c.env
	cmd.WaitDelay = waitDelay
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("systemd-run --help: %w", err)
	}
	if !strings.Contains(string(out), "--expand-environment") {
		return errors.New("systemd-run has no --expand-environment option, systemd 254 or newer is needed")
	}
	l.ready = true
	return nil
}

// NoStartFlag reports whether tmux takes -N (3.2 and later), which keeps
// a command from starting a server. tmux -N -V prints the version and
// starts nothing. An answer from tmux is cached per Client. A probe that
// did not finish reads as false this time and is asked again next time.
// create uses it, and the node passes it to the pty bridge, so an attach
// never starts a server either.
func (c *Client) NoStartFlag(ctx context.Context) bool {
	c.nMu.Lock()
	defer c.nMu.Unlock()
	if c.nKnown {
		return c.nOK
	}
	_, _, err := c.exec(ctx, []string{"-N", "-V"})
	var ce *CommandError
	switch {
	case err == nil:
		c.nKnown, c.nOK = true, true
	case errors.As(err, &ce) && ce.ExitCode > 0:
		// tmux ran and refused the flag.
		c.nKnown = true
	default:
		c.log.Debug("tmux -N probe failed", "error", err)
	}
	return c.nOK
}
