// Package pty attaches a tmux client on a pseudo terminal and streams its
// output as UTF-8 text. It is the Go port of the relay's pty-bridge.ts.
//
// Typical use by one connection:
//
//	b, err := pty.Attach(ctx, name, pty.Options{Socket: sock, Cols: c, Rows: r})
//	if err != nil { /* PTY_SPAWN_FAILED */ }
//	if b.AwaitReady() { /* session:attached, then the capture replay */ }
//	for s := range b.Output() { /* terminal:output */ }
//	res := b.Wait() // Detached: say nothing. SpawnErr: spawn failure. Else exit.
//
// Output is a bounded channel. A consumer that stops draining it stops the
// pty reader, and that is the whole backpressure story. See emit. A consumer
// that walks away must call Close or cancel ctx, or the reader stays parked.
package pty

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	cpty "github.com/creack/pty"
	"golang.org/x/sys/unix"

	"tmuxde/internal/config"
)

// Defaults. ReadyTimeout and the 80x24 size match pty-bridge.ts.
const (
	DefaultQueueSize    = 64
	DefaultReadBuffer   = 32 * 1024
	DefaultReadyTimeout = 50 * time.Millisecond
	DefaultCols         = 80
	DefaultRows         = 24

	// term is the TERM tmux sees for the browser terminal.
	term = "xterm-256color"
	// drainGrace bounds how long the reader waits for more output once the
	// process has exited. Something else may still hold the pty slave open.
	// node-pty waits 200 ms for the same reason.
	drainGrace = 200 * time.Millisecond
	// killGrace is how long a SIGHUP gets before SIGKILL follows.
	killGrace = 2 * time.Second
	// waitDelay bounds Wait when a stray process keeps the stderr pipe open.
	waitDelay = time.Second
	// stderrCap caps what is kept of tmux stderr.
	stderrCap = 4096
)

// Options configures Attach. Zero values pick the defaults.
type Options struct {
	// Tmux is the tmux binary. Default "tmux" from PATH.
	Tmux string
	// Socket is passed as -S when set.
	Socket string
	// NoStart passes -N, so the attach client never starts a tmux server.
	// attach-session starts one when none runs. That server would live in
	// the cgroup of the tmuxde unit and die at its next restart. A missing
	// server is then a spawn error instead. Only tmux 3.2 and later take
	// -N. tmux.Client.NoStartFlag tells.
	NoStart bool
	// ReadOnly attaches with -r. On its own this is not a boundary: tmux
	// still honours detach-client and switch-client under -r. The relay
	// only set it for locked down clones.
	ReadOnly bool
	// Cols and Rows are the initial size. Default 80x24.
	Cols, Rows int
	// Dir is the working directory. Default $HOME when it is a directory,
	// else "/". A missing Dir fails the start.
	Dir string
	// Env is the base environment. Default os.Environ(). TERM is always
	// forced to xterm-256color, and TMUX and TMUX_PANE are dropped so a
	// server started from inside a tmux pane can still attach. tmuxde
	// settings such as AUTH_TOKEN and TMUXDE_LISTEN are dropped too
	// (config.IsSetting). An attach that starts the tmux server would put
	// them in the global environment of every pane.
	Env []string
	// QueueSize is the capacity of Output in chunks. Default 64.
	QueueSize int
	// ReadBuffer is the size of one pty read in bytes. Default 32 KiB.
	// Linux pty reads return at most about 4 KiB anyway.
	ReadBuffer int
	// ReadyTimeout fires ready when tmux has not written anything yet.
	// Default 50 ms.
	ReadyTimeout time.Duration
	// Logger gets spawn and exit records. Default slog.Default().
	Logger *slog.Logger
}

func (o Options) withDefaults() Options {
	if o.Tmux == "" {
		o.Tmux = "tmux"
	}
	if o.Cols <= 0 {
		o.Cols = DefaultCols
	}
	if o.Rows <= 0 {
		o.Rows = DefaultRows
	}
	if o.Dir == "" {
		o.Dir = "/"
		if home := os.Getenv("HOME"); home != "" && isDir(home) {
			o.Dir = home
		}
	}
	if o.Env == nil {
		o.Env = os.Environ()
	}
	if o.QueueSize <= 0 {
		o.QueueSize = DefaultQueueSize
	}
	if o.ReadBuffer <= 0 {
		o.ReadBuffer = DefaultReadBuffer
	}
	if o.ReadyTimeout <= 0 {
		o.ReadyTimeout = DefaultReadyTimeout
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	return o
}

// Result tells how a bridge ended. Read it with Wait.
type Result struct {
	// ExitCode is the exit status. It is 0 when a signal ended the
	// process, as node-pty reports it.
	ExitCode int
	// Signal is the signal that ended the process, or 0.
	Signal syscall.Signal
	// SpawnErr is set when the process exited before ready and the bridge
	// was not detaching. The attach never took. Report it as a spawn
	// failure, not as an exit.
	SpawnErr error
	// Detached is true when MarkDetaching or Close came first. The end was
	// asked for and must stay silent: no exit and no spawn error.
	Detached bool
	// Stderr is the start of what tmux wrote to stderr. On a failed attach
	// it holds the reason, for example "can't find session: x".
	Stderr string
}

// Bridge is one tmux client on a pty. All methods are safe for concurrent
// use.
type Bridge struct {
	session string
	cmd     *exec.Cmd
	master  *os.File
	log     *slog.Logger
	stderr  *capped
	bufSize int

	out        chan string
	ready      chan struct{}
	done       chan struct{}
	stop       chan struct{}
	readerDone chan struct{}

	mu         sync.Mutex
	isReady    bool
	finished   bool
	killed     bool
	readyTimer *time.Timer
	killTimer  *time.Timer

	readyFlag atomic.Bool
	detaching atomic.Bool
	exited    atomic.Bool
	stopOnce  sync.Once
	wg        sync.WaitGroup

	// result is written once before done closes and only read after.
	result Result
}

// Attach runs tmux -u [-N] [-S socket] attach-session [-r] -t =session on a
// new pty.
//
// The "=" asks tmux for an exact name match. Without it tmux falls back to
// a prefix and then an fnmatch pattern. A killed session "wor" would then
// attach "work", and "__tmuxde" would reach a hidden clone.
//
// The tmux client also gets -u. The browser terminal is always UTF-8, and
// without -u tmux picks its output encoding from LANG and LC_*. The relay
// container sets C.UTF-8. A host service may have no locale at all, and
// tmux would then draw every non ASCII cell as "_". With Options.NoStart
// it gets -N as well.
//
// An error means nothing was started. Once Attach returns a bridge, ctx
// cancellation, Close or the process exit ends it.
func Attach(ctx context.Context, session string, o Options) (*Bridge, error) {
	if session == "" {
		return nil, errors.New("pty: empty session name")
	}
	o = o.withDefaults()
	cmd := exec.Command(o.Tmux, attachArgs(session, o)...)
	cmd.Dir = o.Dir
	cmd.Env = attachEnv(o.Env)
	return start(ctx, cmd, session, o)
}

func attachArgs(session string, o Options) []string {
	args := []string{"-u"}
	if o.NoStart {
		args = append(args, "-N")
	}
	if o.Socket != "" {
		args = append(args, "-S", o.Socket)
	}
	args = append(args, "attach-session")
	if o.ReadOnly {
		args = append(args, "-r")
	}
	return append(args, "-t", "="+session)
}

func attachEnv(base []string) []string {
	env := make([]string, 0, len(base)+1)
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		switch {
		case k == "TERM", k == "TMUX", k == "TMUX_PANE", config.IsSetting(k):
			continue
		}
		env = append(env, kv)
	}
	return append(env, "TERM="+term)
}

// start runs cmd on a new pty. Attach builds the tmux command. Tests pass
// other commands to check the stream without tmux in the middle.
func start(ctx context.Context, cmd *exec.Cmd, session string, o Options) (*Bridge, error) {
	o = o.withDefaults()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if o.Cols > 0xFFFF || o.Rows > 0xFFFF {
		return nil, fmt.Errorf("pty: size %dx%d out of range", o.Cols, o.Rows)
	}

	// stderr goes to a pipe, not the pty. tmux writes start up failures
	// there ("can't find session", "no server running"). On the pty they
	// would count as first output, fire ready and turn a failed attach into
	// a phony attach plus exit. Here they end up in the spawn error.
	stderr := &capped{max: stderrCap}
	cmd.Stderr = stderr
	cmd.WaitDelay = waitDelay

	ws := &cpty.Winsize{Cols: uint16(o.Cols), Rows: uint16(o.Rows)}
	master, err := cpty.StartWithSize(cmd, ws)
	if err != nil {
		// A missing Dir also shows up as "fork/exec ...: no such file or
		// directory", so name the directory too.
		return nil, fmt.Errorf("pty: start %s in %q: %w", cmd.Path, cmd.Dir, err)
	}
	// Register a nonblocking descriptor with Go's poller. Setting the flag
	// alone does not register masters created with NewFile on macOS/BSD.
	pollable, err := pollableMaster(master)
	_ = master.Close()
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, fmt.Errorf("pty: poller: %w", err)
	}
	master = pollable

	b := &Bridge{
		session:    session,
		cmd:        cmd,
		master:     master,
		log:        o.Logger,
		stderr:     stderr,
		bufSize:    o.ReadBuffer,
		out:        make(chan string, o.QueueSize),
		ready:      make(chan struct{}),
		done:       make(chan struct{}),
		stop:       make(chan struct{}),
		readerDone: make(chan struct{}),
	}
	b.log.Info("pty spawned", "session", session, "pid", cmd.Process.Pid, "cols", o.Cols, "rows", o.Rows)

	b.mu.Lock()
	b.readyTimer = time.AfterFunc(o.ReadyTimeout, b.timerReady)
	b.mu.Unlock()

	b.wg.Add(3)
	go b.readLoop()
	go b.waitLoop()
	go b.watch(ctx)
	return b, nil
}

// Session returns the session name given to Attach.
func (b *Bridge) Session() string { return b.session }

// Pid returns the tmux client pid.
func (b *Bridge) Pid() int { return b.cmd.Process.Pid }

// Output delivers pty output as valid UTF-8 text, in order. It is closed
// after the last chunk, just before Done closes.
func (b *Bridge) Output() <-chan string { return b.out }

// Ready is closed on first output or after ReadyTimeout, whichever comes
// first. It is never closed when the bridge ends before that.
func (b *Bridge) Ready() <-chan struct{} { return b.ready }

// AwaitReady blocks until ready fires or the bridge ends without it, and
// reports whether ready fired. Prefer it to a select on Ready and Done: when
// tmux writes and exits at once both are closed and select picks either.
// Ready always fires before Done closes, so the answer here is final.
func (b *Bridge) AwaitReady() bool {
	select {
	case <-b.ready:
		return true
	case <-b.done:
		select {
		case <-b.ready:
			return true
		default:
			return false
		}
	}
}

// Done is closed once the process is reaped, Output is closed and Wait
// would not block.
func (b *Bridge) Done() <-chan struct{} { return b.done }

// Wait blocks until Done and returns how the bridge ended. It does not
// drain Output. A consumer that stops draining must call Close instead.
func (b *Bridge) Wait() Result {
	<-b.done
	return b.result
}

// Write sends input to tmux. It blocks while the pty input buffer is full,
// that is while tmux does not read. It fails once the bridge is closed.
func (b *Bridge) Write(p []byte) (int, error) { return b.master.Write(p) }

// WriteString is Write for a string.
func (b *Bridge) WriteString(s string) (int, error) { return b.master.WriteString(s) }

// Resize sets the pty size. The kernel sends SIGWINCH to tmux, but only
// when the size really changes.
func (b *Bridge) Resize(cols, rows int) error {
	if cols < 1 || rows < 1 || cols > 0xFFFF || rows > 0xFFFF {
		return fmt.Errorf("pty: size %dx%d out of range", cols, rows)
	}
	return setSize(b.master, &cpty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// MarkDetaching tells the bridge that its end is expected. The exit or
// spawn error that follows is reported as Detached instead.
func (b *Bridge) MarkDetaching() { b.detaching.Store(true) }

// Detaching reports whether MarkDetaching or Close was called.
func (b *Bridge) Detaching() bool { return b.detaching.Load() }

// Kill sends SIGHUP to tmux, as node-pty kill() does. The tmux client then
// detaches and the session stays alive. SIGKILL follows if the process is
// still there after two seconds. Kill also cancels the ready timer, so a
// bridge killed before any output and without MarkDetaching ends with a
// spawn error, as in pty-bridge.ts. Kill does not wait. Use Close for that.
func (b *Bridge) Kill() error {
	b.mu.Lock()
	if b.finished {
		b.mu.Unlock()
		return nil
	}
	b.killed = true
	b.readyTimer.Stop()
	if b.killTimer == nil {
		p := b.cmd.Process
		b.killTimer = time.AfterFunc(killGrace, func() { _ = p.Kill() })
	}
	b.mu.Unlock()
	err := b.cmd.Process.Signal(syscall.SIGHUP)
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

// Close marks the bridge detaching, kills tmux, drops output nobody has
// read and waits until every goroutine of the bridge has returned. It is
// safe to call more than once and from any goroutine.
func (b *Bridge) Close() error {
	b.shutdown()
	<-b.done
	b.wg.Wait()
	return nil
}

// shutdown starts the teardown without waiting for it.
func (b *Bridge) shutdown() {
	b.MarkDetaching()
	b.stopOnce.Do(func() { close(b.stop) })
	_ = b.Kill()
	// Closing the master hangs up the slave and wakes a reader parked in
	// the poller. Output still in the kernel buffer is lost, which is fine
	// because nobody wants it any more.
	_ = b.master.Close()
}

func (b *Bridge) watch(ctx context.Context) {
	defer b.wg.Done()
	select {
	case <-ctx.Done():
		b.shutdown()
	case <-b.done:
	}
}

func (b *Bridge) readLoop() {
	defer b.wg.Done()
	defer close(b.readerDone)
	buf := make([]byte, b.bufSize)
	err := pump(b.master, buf, b.refreshDeadline, b.emit)
	if err != nil && !isEndOfPty(err) {
		b.log.Debug("pty read ended", "session", b.session, "err", err)
	}
}

// refreshDeadline runs before every read. Once the process has exited the
// reader only waits drainGrace for more. Data already in the kernel buffer
// is read at once, so a slow consumer loses nothing.
func (b *Bridge) refreshDeadline() {
	if b.exited.Load() {
		_ = b.master.SetReadDeadline(time.Now().Add(drainGrace))
	}
}

// emit hands one chunk to the consumer.
//
// Backpressure: the reader goroutine is the only reader of the pty master.
// When Output is full, emit blocks, so the reader stops calling read(2).
// The kernel pty buffer between slave and master then fills up, and a
// writer on the slave side blocks in write(2) or gets EAGAIN. tmux writes
// its client tty non blocking. It stops writing, keeps a bounded buffer for
// that client, and past a limit it discards and redraws later. A program
// that writes the pty directly simply sleeps in write(2). Memory held per
// bridge is at most QueueSize chunks plus the read buffer. Nothing grows
// without bound. This replaces node-pty pause and resume: a consumer that
// stops draining Output is the pause.
func (b *Bridge) emit(s string) bool {
	b.markReady()
	select {
	case b.out <- s:
		return true
	case <-b.stop:
		return false
	}
}

func (b *Bridge) markReady() {
	if b.readyFlag.Load() {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.isReady || b.finished {
		return
	}
	b.readyTimer.Stop()
	b.setReadyLocked()
}

func (b *Bridge) timerReady() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.isReady || b.finished || b.killed {
		return
	}
	b.setReadyLocked()
}

func (b *Bridge) setReadyLocked() {
	b.isReady = true
	b.readyFlag.Store(true)
	close(b.ready)
}

// waitLoop reaps the process, waits for the reader to drain and then
// publishes the result. Exit is classified only after all output was read,
// like node-pty, which emits exit after the pty socket closed.
func (b *Bridge) waitLoop() {
	defer b.wg.Done()
	_ = b.cmd.Wait()
	b.exited.Store(true)
	// The reader may be parked in read(2) with no deadline. Give it one.
	_ = b.master.SetReadDeadline(time.Now().Add(drainGrace))
	<-b.readerDone
	_ = b.master.Close()

	b.mu.Lock()
	b.finished = true
	b.readyTimer.Stop()
	if b.killTimer != nil {
		b.killTimer.Stop()
	}
	ready := b.isReady
	b.mu.Unlock()

	res := Result{Stderr: b.stderr.String()}
	if ws, ok := b.cmd.ProcessState.Sys().(syscall.WaitStatus); ok {
		if ws.Signaled() {
			res.Signal = ws.Signal()
		} else {
			res.ExitCode = ws.ExitStatus()
		}
	}
	switch {
	case b.detaching.Load():
		res.Detached = true
	case !ready:
		msg := fmt.Sprintf("tmux attach-session exited with code %d before ready", res.ExitCode)
		if res.Signal != 0 {
			msg = fmt.Sprintf("tmux attach-session ended by %v before ready", res.Signal)
		}
		if reason := strings.TrimSpace(res.Stderr); reason != "" {
			msg += ": " + reason
		}
		res.SpawnErr = errors.New(msg)
	}
	b.log.Info("pty exited", "session", b.session, "exitCode", res.ExitCode,
		"signal", int(res.Signal), "detaching", res.Detached, "ready", ready)

	b.result = res
	close(b.out)
	close(b.done)
}

// isEndOfPty reports the errors that mean a normal end of the stream.
// Linux returns EIO on the master once every slave descriptor is closed.
func isEndOfPty(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, syscall.EIO) ||
		errors.Is(err, os.ErrClosed) || errors.Is(err, os.ErrDeadlineExceeded) ||
		errors.Is(err, errStopped)
}

// pollableMaster duplicates f and sets O_NONBLOCK before NewFile, so Go
// registers the new file with its poller. The caller still owns f.
func pollableMaster(f *os.File) (*os.File, error) {
	rc, err := f.SyscallConn()
	if err != nil {
		return nil, err
	}
	var fd int
	var serr error
	if err := rc.Control(func(original uintptr) {
		fd, serr = unix.FcntlInt(original, unix.F_DUPFD_CLOEXEC, 0)
	}); err != nil {
		return nil, err
	}
	if serr != nil {
		return nil, serr
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	master := os.NewFile(uintptr(fd), f.Name())
	// Fail attachment if this platform cannot poll the descriptor. Otherwise
	// an idle read would return EAGAIN and silently stop live output.
	if err := master.SetReadDeadline(time.Time{}); err != nil {
		_ = master.Close()
		return nil, err
	}
	return master, nil
}

// setSize is cpty.Setsize without File.Fd. Setsize calls Fd, which would
// switch the master back to blocking mode on every resize.
func setSize(f *os.File, ws *cpty.Winsize) error {
	rc, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var serr error
	err = rc.Control(func(fd uintptr) {
		_, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(ws)))
		if e != 0 {
			serr = e
		}
	})
	if err != nil {
		return err
	}
	return serr
}

func isDir(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

// capped keeps the first max bytes written to it.
type capped struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if room := c.max - len(c.buf); room > 0 {
		c.buf = append(c.buf, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

func (c *capped) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return string(c.buf)
}
