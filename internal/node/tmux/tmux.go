// Package tmux drives the tmux command line for one machine. It is the Go
// port of the relay's tmux-manager.ts, plus the clone name filter and the
// startup sweep of tmux-clone.ts. Clone creation is not ported.
//
// Every tmux command runs without a shell, with a timeout and a cap on
// stdout. Methods are safe for concurrent use.
//
// Targets. A session name always goes to tmux as an exact match: "=name"
// where tmux expects a session, "=name:" where it expects a window or a
// pane. Without "=" tmux falls back to a prefix and then an fnmatch
// pattern, so "wor" would hit "work". The trailing colon matters too: for a
// pane target tmux reads a bare "=name" as a pane, finds nothing and
// display-message then prints empty fields with exit 0. Session names tmux
// would misread are refused before tmux runs, at create and rename as well.
// checkSession has the rule. Pane ids ("%3") and window ids ("@2") are
// exact already and pass through as they are.
//
// Commands. Options.DefaultShell is the command for a new session or window
// that asks for none. Without it tmux gets no command at all and applies
// its own default-command and default-shell options.
//
// Server start. tmux starts its server from the first client that needs
// one, and the server stays in the process tree and cgroup of that client.
// Under a systemd unit a restart of the unit would kill it and every
// session. See launcher.go for how new-session avoids that.
//
// Folders. Every tmux call runs in Options.Dir, the user home by default.
// tmux starts a session or window that names no folder in the folder of
// the client that asked. The process folder depends on how tmuxde was
// started, so it never reaches tmux. The relay got the same home folder
// another way: its container folder did not exist on the host, and tmux
// fell back to home.
package tmux

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"tmuxde/internal/config"
)

// Defaults for Options and capture.
const (
	defaultTimeout      = 10 * time.Second
	defaultMaxOutput    = 16 << 20
	defaultCaptureLines = 2000

	// stderrCap caps what is kept of tmux stderr.
	stderrCap = 4096
	// waitDelay bounds Wait when a stray process keeps a pipe open. The
	// tmux server daemonizes and closes stdio, so this is a backstop.
	waitDelay = time.Second
)

// ClonePrefix starts the name of every read only clone session the relay
// created. Such sessions are relay plumbing. They stay hidden from every
// list and broadcast, are refused on attach, and are killed at startup.
const ClonePrefix = "__tmuxde_"

// IsClone reports whether name is a clone session.
func IsClone(name string) bool { return strings.HasPrefix(name, ClonePrefix) }

// Options configures a Client. Zero values pick the defaults.
type Options struct {
	// Socket is passed as -S when set. Empty means the tmux default.
	Socket string
	// Dir is the working folder of every tmux call, so it is where a new
	// session or window that names no folder starts. Empty, relative or
	// not a directory falls back to HOME, then to /.
	Dir string
	// DefaultShell runs in new sessions and windows that ask for no
	// command. Empty passes no command, so tmux applies the user's
	// default-command and default-shell options.
	DefaultShell string
	// Timeout bounds one tmux call. Default 10 s.
	Timeout time.Duration
	// MaxOutput caps stdout of one tmux call in bytes. Output past it is
	// cut, not an error. Default 16 MiB.
	MaxOutput int
	// Logger gets one record per change made and per failed listing, at
	// Debug when the listed session or window is gone. Default
	// slog.Default().
	Logger *slog.Logger
	// Launcher says how new-session starts a tmux server when none runs.
	// Empty means LauncherAuto. See launcher.go.
	Launcher Launcher
}

// Client runs tmux commands against one server.
type Client struct {
	opts Options
	log  *slog.Logger
	// bin is the tmux binary. Tests swap it for other programs.
	bin string
	env []string

	// zMu guards the select-pane -Z probe. Only a probe that ran is
	// cached. A failed one is asked again next time.
	zMu    sync.Mutex
	zKnown bool
	zOK    bool

	// launch starts the tmux server outside the service. Nil runs
	// new-session plainly.
	launch *launcher
	// nMu guards the tmux -N probe, cached like the -Z probe.
	nMu    sync.Mutex
	nKnown bool
	nOK    bool
}

// New returns a client for opts.
func New(opts Options) *Client {
	if opts.Timeout <= 0 {
		opts.Timeout = defaultTimeout
	}
	if opts.MaxOutput <= 0 {
		opts.MaxOutput = defaultMaxOutput
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	opts.Dir = workDir(opts.Dir)
	c := &Client{opts: opts, log: opts.Logger, bin: "tmux", env: commandEnv(os.Environ())}
	c.launch = newLauncher(opts.Launcher, opts.Logger)
	return c
}

// workDir picks the folder tmux runs in: dir, else HOME, else /. The
// check runs once. A folder removed later makes every tmux call fail.
func workDir(dir string) string {
	for _, d := range []string{dir, os.Getenv("HOME")} {
		if d == "" || !filepath.IsAbs(d) {
			continue
		}
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			return filepath.Clean(d)
		}
	}
	return "/"
}

// commandEnv drops variables tmux must not see.
//
// The command that starts the tmux server hands it its environment, and
// every pane inherits that. tmuxde settings must not end up there
// (config.IsSetting). AUTH_TOKEN is one of them. Others such as
// TMUXDE_LISTEN and TMUXDE_CONFIG_DIR would make a tmuxde serve started in
// a pane take over the production socket and state. The variables systemd
// sets for the tmuxde unit (unitEnv) go too. TMUX and TMUX_PANE would
// point tmux at the server of the pane tmuxde was started from when no
// socket is set. The pty bridge drops them as well, so both talk to the
// same server.
func commandEnv(base []string) []string {
	env := make([]string, 0, len(base))
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		switch {
		case k == "TMUX", k == "TMUX_PANE", config.IsSetting(k):
			continue
		case slices.Contains(unitEnv, k):
			continue
		}
		env = append(env, kv)
	}
	return env
}

// Errors. Match them with errors.Is.
var (
	// ErrNoServer means no tmux server runs on the socket.
	ErrNoServer = errors.New("tmux: no server running")
	// ErrNotFound means tmux could not find the session, window or pane.
	ErrNotFound = errors.New("tmux: target not found")
	// ErrInvalidArgument means a name, id or value was refused before
	// tmux ran.
	ErrInvalidArgument = errors.New("tmux: invalid argument")
)

// CommandError is a tmux call that failed. Error includes the stderr text,
// which is what the browser gets as the HANDLER_ERROR message.
type CommandError struct {
	// Args is the argv after the binary name, the -S flag included.
	Args []string
	// ExitCode is the exit status, or -1 when tmux did not exit on its own.
	ExitCode int
	// Stderr is what tmux wrote to stderr, trimmed and capped.
	Stderr string
	// Err is the cause: an *exec.ExitError, a context error or a start
	// error.
	Err error

	noServer bool
	notFound bool
}

func newCommandError(args []string, cause error, stderr string) *CommandError {
	e := &CommandError{Args: args, ExitCode: -1, Stderr: strings.TrimSpace(stderr), Err: cause}
	var ee *exec.ExitError
	if errors.As(cause, &ee) {
		e.ExitCode = ee.ExitCode()
	}
	e.noServer = isNoServer(e.Stderr)
	e.notFound = strings.HasPrefix(e.Stderr, "can't find ")
	return e
}

func (e *CommandError) Error() string {
	name := "tmux " + subcommand(e.Args)
	switch {
	case errors.Is(e.Err, context.DeadlineExceeded):
		return name + ": command timed out"
	case errors.Is(e.Err, context.Canceled):
		return name + ": command canceled"
	case e.Stderr != "":
		return name + ": " + e.Stderr
	case e.Err != nil:
		return name + ": " + e.Err.Error()
	}
	return name + ": failed"
}

// Unwrap exposes the cause and the matching sentinels to errors.Is.
func (e *CommandError) Unwrap() []error {
	var errs []error
	if e.Err != nil {
		errs = append(errs, e.Err)
	}
	if e.noServer {
		errs = append(errs, ErrNoServer)
	}
	if e.notFound {
		errs = append(errs, ErrNotFound)
	}
	return errs
}

// isNoServer reads the ways tmux says nobody listens on the socket.
// "no server running" means a stale socket file. "error connecting to"
// with a missing path means no socket file at all. That message ends in
// strerror text, which follows the locale, so the path is checked instead
// of the text. "server exited unexpectedly" is a server that went away
// during the call.
func isNoServer(stderr string) bool {
	if strings.Contains(stderr, "no server running") ||
		strings.Contains(stderr, "server exited unexpectedly") {
		return true
	}
	rest, ok := strings.CutPrefix(stderr, "error connecting to ")
	if !ok {
		return false
	}
	i := strings.LastIndex(rest, " (")
	if i <= 0 {
		return false
	}
	_, err := os.Lstat(rest[:i])
	return errors.Is(err, fs.ErrNotExist)
}

// subcommand returns the tmux command name in args, after any -u, -N and -S
// flag.
func subcommand(args []string) string {
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-S":
			i++
			continue
		case "-u", "-N":
			continue
		}
		return args[i]
	}
	return ""
}

// run runs tmux with UTF-8 output and the socket flag and returns stdout.
func (c *Client) run(ctx context.Context, args ...string) (string, error) {
	out, _, err := c.exec(ctx, c.withSocket(args))
	return out, err
}

func (c *Client) withSocket(args []string) []string {
	// Without -u, a C or unset locale makes tmux replace tabs and
	// Unicode with underscores. Inventory parsers need those tabs.
	flags := []string{"-u"}
	if c.opts.Socket != "" {
		flags = append(flags, "-S", c.opts.Socket)
	}
	return append(flags, args...)
}

// exec runs tmux with argv. It reports whether stdout was cut at
// MaxOutput. A cut is logged, not returned as an error.
func (c *Client) exec(ctx context.Context, argv []string) (string, bool, error) {
	return c.execProgram(ctx, c.bin, argv, argv)
}

// execProgram is the one place tmux runs, directly or through the
// launcher, which then is bin. tmuxArgs is the tmux argv a failure
// reports, so the error names the tmux command either way.
func (c *Client) execProgram(ctx context.Context, bin string, argv, tmuxArgs []string) (string, bool, error) {
	return c.execProgramLimit(ctx, bin, argv, tmuxArgs, c.opts.MaxOutput)
}

func (c *Client) execProgramLimit(ctx context.Context, bin string, argv, tmuxArgs []string, limit int) (string, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, c.opts.Timeout)
	defer cancel()

	stdout := &capWriter{max: limit}
	stderr := &capWriter{max: stderrCap}
	cmd := exec.CommandContext(ctx, bin, argv...)
	cmd.Dir = c.opts.Dir
	cmd.Env = c.env
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.WaitDelay = waitDelay

	err := cmd.Run()
	if errors.Is(err, exec.ErrWaitDelay) {
		// tmux exited 0 but something kept the pipe open. What was read
		// is all there is.
		err = nil
	}
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			err = fmt.Errorf("%w (%v)", ctxErr, err)
		}
		return "", false, newCommandError(tmuxArgs, err, stderr.String())
	}
	if stdout.cut {
		c.log.Warn("tmux output cut", "command", subcommand(tmuxArgs), "limit", limit)
	}
	return stdout.String(), stdout.cut, nil
}

// listFailed logs a failed window or pane listing. A missing target is an
// everyday answer: the session was killed or renamed since the caller
// looked. The session monitor asks every second for a session a browser
// still shows under its old name, so that goes to Debug. The caller gets
// the error either way. Anything else is logged as an error.
func (c *Client) listFailed(ctx context.Context, msg string, err error, attrs ...any) {
	level := slog.LevelError
	if errors.Is(err, ErrNotFound) {
		level = slog.LevelDebug
	}
	c.log.Log(ctx, level, msg, append(attrs, "error", err)...)
}

// capWriter keeps the first max bytes written to it and swallows the rest,
// so tmux never blocks on a full pipe.
type capWriter struct {
	buf []byte
	max int
	cut bool
}

func (w *capWriter) Write(p []byte) (int, error) {
	room := w.max - len(w.buf)
	if len(p) > room {
		w.cut = true
	}
	if room > 0 {
		w.buf = append(w.buf, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

func (w *capWriter) String() string { return string(w.buf) }

// Version runs tmux -V without the socket flag. Startup uses it to check
// that tmux is installed.
func (c *Client) Version(ctx context.Context) (string, error) {
	out, _, err := c.exec(ctx, []string{"-V"})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// checkSession refuses names that cannot be a session target. It is the
// one place for the session name rule. The error says why.
//
//   - An empty name would mean "the current session", whichever tmux picks.
//   - tmux never keeps ":" or "." in a session name, and either would make
//     tmux read part of the target as a window or pane.
//   - tmux does allow a leading "$", but it reads "$0" as a session id
//     before any name, "=" or not, so "=$0" would hit session $0.
//   - When no session has the exact name, tmux tries the name of an
//     attached client, such as "pts/3" or "/dev/pts/3", before it gives
//     up. A stale "=pts/3" would hit the session that client shows.
func checkSession(name string) error {
	var why string
	switch {
	case name == "":
		why = "is empty"
	case strings.ContainsAny(name, ":."):
		why = `contains ":" or ".", which tmux reads as a window or pane`
	case name[0] == '$':
		why = `starts with "$", which tmux reads as a session id`
	case strings.Contains(name, "/"):
		why = `contains "/", which tmux can read as a client such as pts/3`
	default:
		return nil
	}
	return fmt.Errorf("%w: session %q %s", ErrInvalidArgument, name, why)
}

// keptName turns ":" and "." into "_", as tmux does with the name of a new
// or renamed session.
var keptName = strings.NewReplacer(":", "_", ".", "_")

// checkNewSession refuses a name for new-session or rename-session that no
// target could reach afterwards. tmux turns ":" and "." into "_" itself,
// so those pass, as they did in the relay. The browser names a session
// after a file, such as "edit-main.go". The name tmux keeps goes through
// checkSession.
func checkNewSession(name string) error {
	return checkSession(keptName.Replace(name))
}

// sessionTarget is the exact match target for a command that takes a
// session.
func sessionTarget(name string) (string, error) {
	if err := checkSession(name); err != nil {
		return "", err
	}
	return "=" + name, nil
}

// currentTarget is the exact match target for the current window or the
// active pane of a session.
func currentTarget(name string) (string, error) {
	if err := checkSession(name); err != nil {
		return "", err
	}
	return "=" + name + ":", nil
}

// checkID refuses anything but a tmux id: the prefix and digits.
func checkID(kind string, prefix byte, id string) error {
	ok := len(id) > 1 && id[0] == prefix
	for i := 1; ok && i < len(id); i++ {
		ok = id[i] >= '0' && id[i] <= '9'
	}
	if !ok {
		return fmt.Errorf("%w: %s id %q", ErrInvalidArgument, kind, id)
	}
	return nil
}

func checkPaneID(id string) error   { return checkID("pane", '%', id) }
func checkWindowID(id string) error { return checkID("window", '@', id) }

func checkOneOf(field, value string, allowed []string) error {
	for _, a := range allowed {
		if value == a {
			return nil
		}
	}
	return fmt.Errorf("%w: %s %q", ErrInvalidArgument, field, value)
}
