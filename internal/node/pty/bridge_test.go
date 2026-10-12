package pty

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

var quiet = slog.New(slog.DiscardHandler)

// tmuxServer is a tmux server on its own socket in a temp dir. Tests never
// talk to the default server.
type tmuxServer struct {
	t    *testing.T
	sock string
}

func newTmux(t *testing.T, sessions ...string) *tmuxServer {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	s := &tmuxServer{t: t, sock: filepath.Join(t.TempDir(), "sock")}
	t.Cleanup(func() {
		cmd := exec.Command("tmux", "-S", s.sock, "kill-server")
		cmd.Env = attachEnv(os.Environ())
		_ = cmd.Run()
	})
	for _, name := range sessions {
		s.run("new-session", "-d", "-s", name, "-x", "80", "-y", "24", "/bin/sh")
	}
	// No status line, so the pane is exactly the pty size.
	s.run("set-option", "-g", "status", "off")
	return s
}

func (s *tmuxServer) run(args ...string) string {
	s.t.Helper()
	out, err := s.try(args...)
	if err != nil {
		s.t.Fatalf("tmux %v: %v: %s", args, err, out)
	}
	return out
}

func (s *tmuxServer) try(args ...string) (string, error) {
	full := append([]string{"-f", "/dev/null", "-S", s.sock}, args...)
	cmd := exec.Command("tmux", full...)
	cmd.Env = attachEnv(os.Environ())
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (s *tmuxServer) attach(t *testing.T, ctx context.Context, session string, o Options) *Bridge {
	t.Helper()
	o.Socket = s.sock
	if o.Logger == nil {
		o.Logger = quiet
	}
	b, err := Attach(ctx, session, o)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })
	return b
}

// readUntil collects output until it contains want.
func readUntil(t *testing.T, b *Bridge, want string, timeout time.Duration) string {
	t.Helper()
	var sb strings.Builder
	deadline := time.After(timeout)
	for !strings.Contains(sb.String(), want) {
		select {
		case s, ok := <-b.Output():
			if !ok {
				t.Fatalf("output closed before %q. Got %q", want, sb.String())
			}
			sb.WriteString(s)
		case <-deadline:
			t.Fatalf("no %q within %v. Got %q", want, timeout, sb.String())
		}
	}
	return sb.String()
}

// drain reads output in the background and returns everything once
// Output closes.
func drain(b *Bridge) <-chan string {
	res := make(chan string, 1)
	go func() {
		var sb strings.Builder
		for s := range b.Output() {
			sb.WriteString(s)
		}
		res <- sb.String()
	}()
	return res
}

func waitDone(t *testing.T, b *Bridge, timeout time.Duration) Result {
	t.Helper()
	select {
	case <-b.Done():
		return b.Wait()
	case <-time.After(timeout):
		t.Fatalf("bridge not done within %v", timeout)
		return Result{}
	}
}

func waitFor(t *testing.T, what string, timeout time.Duration, ok func() (bool, string)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	last := ""
	for time.Now().Before(deadline) {
		var done bool
		if done, last = ok(); done {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s: not reached within %v, last %q", what, timeout, last)
}

func TestAttachShowsCommandOutput(t *testing.T) {
	srv := newTmux(t, "main")
	b := srv.attach(t, context.Background(), "main", Options{})
	if !b.AwaitReady() {
		t.Fatalf("not ready: %+v", b.Wait())
	}
	if _, err := b.WriteString("echo hello-$((6*7))\r"); err != nil {
		t.Fatalf("write: %v", err)
	}
	// The typed text has "$((6*7))". Only the shell output has 42.
	readUntil(t, b, "hello-42", 5*time.Second)

	b.MarkDetaching()
	if err := b.Kill(); err != nil {
		t.Fatalf("kill: %v", err)
	}
	drained := drain(b)
	res := waitDone(t, b, 5*time.Second)
	<-drained
	if !res.Detached || res.SpawnErr != nil {
		t.Fatalf("result %+v, want silent detach", res)
	}
	// Killing the client must leave the session alive.
	srv.run("has-session", "-t", "main")
}

func TestResizeReachesTmux(t *testing.T) {
	srv := newTmux(t, "main")
	b := srv.attach(t, context.Background(), "main", Options{Cols: 80, Rows: 24})
	if !b.AwaitReady() {
		t.Fatalf("not ready: %+v", b.Wait())
	}
	drain(b)
	size := func(want string) func() (bool, string) {
		return func() (bool, string) {
			got, err := srv.try("display-message", "-p", "-t", "main", "#{pane_width}x#{pane_height}")
			return err == nil && got == want, got
		}
	}
	waitFor(t, "initial size", 5*time.Second, size("80x24"))
	if err := b.Resize(100, 30); err != nil {
		t.Fatalf("resize: %v", err)
	}
	waitFor(t, "resized", 5*time.Second, size("100x30"))
	// Same size again is a no-op for the kernel and must not fail.
	if err := b.Resize(100, 30); err != nil {
		t.Fatalf("same size resize: %v", err)
	}
	if err := b.Resize(0, 10); err == nil {
		t.Fatal("resize to 0 cols did not fail")
	}
	if err := b.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := b.Resize(90, 20); err == nil {
		t.Fatal("resize after close did not fail")
	}
	if _, err := b.WriteString("x"); err == nil {
		t.Fatal("write after close did not fail")
	}
}

func TestNonASCIIThroughTmux(t *testing.T) {
	srv := newTmux(t, "main")
	// Two byte reads split every multibyte character tmux sends.
	b := srv.attach(t, context.Background(), "main", Options{ReadBuffer: 2})
	if !b.AwaitReady() {
		t.Fatalf("not ready: %+v", b.Wait())
	}
	// Octal escapes keep the typed line ASCII. Only printf output has the
	// real characters.
	cmd := `printf '<\344\275\240\345\245\275 \303\251t\303\251 \360\237\230\200>\n'` + "\r"
	if _, err := b.WriteString(cmd); err != nil {
		t.Fatalf("write: %v", err)
	}
	out := readUntil(t, b, "été", 5*time.Second)
	out += readUntil(t, b, ">", 5*time.Second)
	for _, want := range []string{"你好", "été", "\U0001F600"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q: %q", want, out)
		}
	}
	if strings.Contains(out, "\uFFFD") {
		t.Errorf("output has U+FFFD: %q", out)
	}
}

func TestBackpressureKeepsOrderAndCompleteness(t *testing.T) {
	const n = 100000
	// seq runs on the pty directly. Through tmux a burst is redrawn, not
	// replayed, so only a raw pty can show that no byte is lost.
	b, err := start(context.Background(), exec.Command("seq", "1", fmt.Sprint(n)), "seq",
		Options{QueueSize: 4, Logger: quiet})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })

	// Nobody drains. The queue fills and stays full.
	waitFor(t, "queue full", 5*time.Second, func() (bool, string) {
		return len(b.Output()) == cap(b.Output()), fmt.Sprint(len(b.Output()))
	})
	time.Sleep(300 * time.Millisecond)
	if got := len(b.Output()); got != 4 {
		t.Fatalf("queue length %d, want 4", got)
	}
	// seq must still be alive, asleep in write(2): the kernel pty buffer is
	// full because the reader stopped reading.
	state, alive := procState(b.Pid())
	if !alive || state == 'Z' {
		t.Fatalf("seq is not running (state %q). Backpressure did not reach it", state)
	}
	select {
	case <-b.Done():
		t.Fatal("bridge finished while output was not drained")
	default:
	}

	var sb strings.Builder
	for s := range b.Output() {
		sb.WriteString(s)
	}
	var want strings.Builder
	for i := 1; i <= n; i++ {
		// The pty line discipline turns \n into \r\n.
		fmt.Fprintf(&want, "%d\r\n", i)
	}
	if got := sb.String(); got != want.String() {
		t.Fatalf("output differs: got %d bytes, want %d. %s", len(got), want.Len(), firstDiff(got, want.String()))
	}
	res := b.Wait()
	if res.SpawnErr != nil || res.Detached || res.ExitCode != 0 {
		t.Fatalf("result %+v, want clean exit", res)
	}
}

func TestSpawnErrorWhenSessionMissing(t *testing.T) {
	srv := newTmux(t, "main")
	b := srv.attach(t, context.Background(), "nope", Options{})
	if b.AwaitReady() {
		t.Fatal("ready fired for a missing session")
	}
	res := b.Wait()
	if res.SpawnErr == nil {
		t.Fatalf("no spawn error: %+v", res)
	}
	msg := res.SpawnErr.Error()
	if !strings.Contains(msg, "before ready") || !strings.Contains(msg, "can't find session") {
		t.Fatalf("spawn error %q lacks the reason", msg)
	}
	if res.ExitCode != 1 || res.Detached {
		t.Fatalf("result %+v", res)
	}
	if s, ok := <-b.Output(); ok {
		t.Fatalf("output after spawn error: %q", s)
	}
}

func TestSpawnErrorWhenNoServer(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	// Plain attach-session starts a server, and that server reads the
	// tmux.conf in HOME. A real one can keep it alive (exit-empty off) and
	// slow enough to fire ready. A fresh HOME keeps the test hermetic.
	home := t.TempDir()
	env := []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	sock := filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() {
		cmd := exec.Command("tmux", "-S", sock, "kill-server")
		cmd.Env = env
		_ = cmd.Run()
	})
	b, err := Attach(context.Background(), "main", Options{Socket: sock, Env: env, Dir: home, Logger: quiet})
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer b.Close()
	if b.AwaitReady() {
		t.Fatal("ready fired with no server")
	}
	if res := b.Wait(); res.SpawnErr == nil {
		t.Fatalf("no spawn error: %+v", res)
	}
}

func TestStartFailureIsSynchronous(t *testing.T) {
	_, err := Attach(context.Background(), "main", Options{Tmux: "/nonexistent/tmux", Logger: quiet})
	if err == nil {
		t.Fatal("Attach with a missing binary did not fail")
	}
	if _, err := Attach(context.Background(), "", Options{Logger: quiet}); err == nil {
		t.Fatal("Attach with an empty name did not fail")
	}
}

func TestExitWhenSessionKilled(t *testing.T) {
	// A second session keeps the server alive after main dies.
	srv := newTmux(t, "main", "other")
	b := srv.attach(t, context.Background(), "main", Options{})
	if !b.AwaitReady() {
		t.Fatalf("not ready: %+v", b.Wait())
	}
	out := drain(b)
	srv.run("kill-session", "-t", "main")
	res := waitDone(t, b, 5*time.Second)
	text := <-out
	if res.SpawnErr != nil || res.Detached {
		t.Fatalf("result %+v, want a plain exit", res)
	}
	if res.ExitCode != 0 || res.Signal != 0 {
		t.Fatalf("exit %d signal %v, want 0", res.ExitCode, res.Signal)
	}
	if !strings.Contains(text, "[exited]") {
		t.Errorf("output lacks tmux exit notice: %q", tail(text, 200))
	}
}

func TestReadyOnFirstOutput(t *testing.T) {
	b, err := start(context.Background(), exec.Command("sh", "-c", "echo hi; sleep 5"), "x",
		Options{ReadyTimeout: 10 * time.Second, Logger: quiet})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer b.Close()
	select {
	case <-b.Ready():
	case <-time.After(5 * time.Second):
		t.Fatal("ready did not fire on output")
	}
	if s := <-b.Output(); s != "hi\r\n" {
		t.Fatalf("first chunk %q", s)
	}
}

func TestReadyAfterTimeout(t *testing.T) {
	b, err := start(context.Background(), exec.Command("sleep", "5"), "x",
		Options{ReadyTimeout: 50 * time.Millisecond, Logger: quiet})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	t0 := time.Now()
	if !b.AwaitReady() {
		t.Fatalf("not ready: %+v", b.Wait())
	}
	if d := time.Since(t0); d > 2*time.Second {
		t.Fatalf("ready took %v", d)
	}
	if err := b.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if res := b.Wait(); !res.Detached {
		t.Fatalf("result %+v, want detached after Close", res)
	}
}

func TestExitBeforeReadyIsSpawnError(t *testing.T) {
	b, err := start(context.Background(), exec.Command("sh", "-c", "exit 3"), "x",
		Options{ReadyTimeout: 5 * time.Second, Logger: quiet})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	res := waitDone(t, b, 5*time.Second)
	if res.SpawnErr == nil || res.ExitCode != 3 {
		t.Fatalf("result %+v, want spawn error with code 3", res)
	}
	if want := "tmux attach-session exited with code 3 before ready"; res.SpawnErr.Error() != want {
		t.Fatalf("message %q, want %q", res.SpawnErr, want)
	}
}

func TestDetachingSilencesEarlyExit(t *testing.T) {
	b, err := start(context.Background(), exec.Command("sh", "-c", "exit 3"), "x",
		Options{ReadyTimeout: 5 * time.Second, Logger: quiet})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	b.MarkDetaching()
	if res := waitDone(t, b, 5*time.Second); !res.Detached || res.SpawnErr != nil {
		t.Fatalf("result %+v, want silent detach", res)
	}
}

func TestKillBeforeReadyCancelsTimer(t *testing.T) {
	b, err := start(context.Background(), exec.Command("sleep", "5"), "x",
		Options{ReadyTimeout: 200 * time.Millisecond, Logger: quiet})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := b.Kill(); err != nil {
		t.Fatalf("kill: %v", err)
	}
	res := waitDone(t, b, 5*time.Second)
	if b.AwaitReady() {
		t.Fatal("ready fired after Kill")
	}
	if res.SpawnErr == nil || res.Signal == 0 {
		t.Fatalf("result %+v, want spawn error from SIGHUP", res)
	}
}

func TestContextCancelStopsBridge(t *testing.T) {
	srv := newTmux(t, "main")
	ctx, cancel := context.WithCancel(context.Background())
	b := srv.attach(t, ctx, "main", Options{})
	if !b.AwaitReady() {
		t.Fatalf("not ready: %+v", b.Wait())
	}
	// Nobody drains. Cancel must still end everything.
	cancel()
	res := waitDone(t, b, 5*time.Second)
	if !res.Detached {
		t.Fatalf("result %+v, want detached", res)
	}
	for range b.Output() {
	}
	srv.run("has-session", "-t", "main")
}

func TestCloseWithoutDraining(t *testing.T) {
	b, err := start(context.Background(), exec.Command("seq", "1", "1000000"), "seq",
		Options{QueueSize: 1, Logger: quiet})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	waitFor(t, "queue full", 5*time.Second, func() (bool, string) {
		return len(b.Output()) == 1, ""
	})
	closed := make(chan struct{})
	go func() { _ = b.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Close blocked on an undrained queue")
	}
}

func TestCloseEscalatesWhenHangupIgnored(t *testing.T) {
	// The shell ignores SIGHUP, and so does its sleep child, which also
	// keeps the pty slave and the stderr pipe open after the shell dies.
	b, err := start(context.Background(), exec.Command("sh", "-c", `trap "" HUP; echo up; sleep 4; true`), "x",
		Options{Logger: quiet})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if !b.AwaitReady() {
		t.Fatalf("not ready: %+v", b.Wait())
	}
	t0 := time.Now()
	closed := make(chan struct{})
	go func() { _ = b.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("Close hung on a process that ignores SIGHUP")
	}
	if d := time.Since(t0); d < killGrace {
		t.Fatalf("Close took %v, before the SIGKILL grace. SIGHUP was not ignored?", d)
	}
	if res := b.Wait(); !res.Detached {
		t.Fatalf("result %+v, want detached", res)
	}
}

func TestNoGoroutineLeak(t *testing.T) {
	srv := newTmux(t, "main", "other", "victim")
	settle := func() int {
		runtime.GC()
		time.Sleep(50 * time.Millisecond)
		return runtime.NumGoroutine()
	}
	before := settle()

	for i := 0; i < 3; i++ {
		// Attach, read, Close.
		b, err := Attach(context.Background(), "main", Options{Socket: srv.sock, Logger: quiet})
		if err != nil {
			t.Fatalf("Attach: %v", err)
		}
		b.AwaitReady()
		_ = b.Close()

		// Context cancel without draining.
		ctx, cancel := context.WithCancel(context.Background())
		b, err = Attach(ctx, "other", Options{Socket: srv.sock, Logger: quiet})
		if err != nil {
			t.Fatalf("Attach: %v", err)
		}
		b.AwaitReady()
		cancel()
		<-b.Done()

		// Spawn error.
		b, err = Attach(context.Background(), "nope", Options{Socket: srv.sock, Logger: quiet})
		if err != nil {
			t.Fatalf("Attach: %v", err)
		}
		b.Wait()

		// Undrained raw output, then Close.
		b, err = start(context.Background(), exec.Command("seq", "1", "100000"), "seq",
			Options{QueueSize: 2, Logger: quiet})
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		_ = b.Close()
	}

	// Session killed while attached, drained to the end.
	b, err := Attach(context.Background(), "victim", Options{Socket: srv.sock, Logger: quiet})
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	b.AwaitReady()
	out := drain(b)
	srv.run("kill-session", "-t", "victim")
	waitDone(t, b, 5*time.Second)
	<-out

	deadline := time.Now().Add(3 * time.Second)
	after := settle()
	for after > before && time.Now().Before(deadline) {
		after = settle()
	}
	if after > before {
		buf := make([]byte, 1<<16)
		buf = buf[:runtime.Stack(buf, true)]
		t.Fatalf("goroutines: %d before, %d after.\n%s", before, after, buf)
	}
}

func TestAttachArgsAndEnv(t *testing.T) {
	got := attachArgs("s", Options{Socket: "/x/sock", ReadOnly: true})
	want := []string{"-u", "-S", "/x/sock", "attach-session", "-r", "-t", "=s"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("args %q, want %q", got, want)
	}
	if got := attachArgs("s", Options{}); strings.Join(got, " ") != "-u attach-session -t =s" {
		t.Fatalf("args %q", got)
	}
	got = attachArgs("s", Options{Socket: "/x/sock", NoStart: true})
	if strings.Join(got, " ") != "-u -N -S /x/sock attach-session -t =s" {
		t.Fatalf("args with NoStart %q", got)
	}
	env := attachEnv([]string{
		"TERM=dumb", "TMUX=/tmp/x,1,0", "TMUX_PANE=%1", "HOME=/h", "AUTH_TOKEN=x", "TMUXDE_X=1",
		"TMUXDE_LISTEN=unix:/run/http.sock", "TMUXDE_CONFIG_DIR=/c", "ALLOWED_PATHS=/h", "CORS_ORIGINS=https://x",
		"STT_SOCKET=/run/stt.sock", "TMUX_SOCKET=/s", "TMUX_DEFAULT_SHELL=/bin/sh", "IDLE_TIMEOUT_MINUTES=5",
		"PATH=/usr/bin", "LANG=C.UTF-8",
	})
	if strings.Join(env, " ") != "HOME=/h PATH=/usr/bin LANG=C.UTF-8 TERM=xterm-256color" {
		t.Fatalf("env %q", env)
	}
}

// TestNoStartLeavesServerAlone attaches with no server on the socket and a
// tmux config that creates a session. Plain attach-session starts a server
// that stays for that session. With NoStart the attach fails and nothing
// runs on the socket.
func TestNoStartLeavesServerAlone(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	if err := exec.Command("tmux", "-N", "-V").Run(); err != nil {
		t.Skip("tmux before 3.2 has no -N")
	}
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".tmux.conf"), []byte("new-session -d -s keep\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	running := func(sock string) bool {
		cmd := exec.Command("tmux", "-N", "-S", sock, "has-session", "-t", "=keep")
		cmd.Env = env
		return cmd.Run() == nil
	}
	attach := func(sock string, noStart bool) Result {
		t.Cleanup(func() {
			cmd := exec.Command("tmux", "-N", "-S", sock, "kill-server")
			cmd.Env = env
			_ = cmd.Run()
		})
		b, err := Attach(context.Background(), "nope", Options{Socket: sock, NoStart: noStart, Env: env, Dir: home, Logger: quiet})
		if err != nil {
			t.Fatalf("Attach: %v", err)
		}
		defer b.Close()
		if b.AwaitReady() {
			t.Fatal("ready fired for a missing session")
		}
		return waitDone(t, b, 10*time.Second)
	}

	plain := filepath.Join(t.TempDir(), "plain")
	if res := attach(plain, false); res.SpawnErr == nil {
		t.Fatalf("plain attach: no spawn error: %+v", res)
	}
	if !running(plain) {
		t.Fatal("plain attach-session started no server. The test config did not load")
	}

	sock := filepath.Join(t.TempDir(), "nostart")
	res := attach(sock, true)
	if res.SpawnErr == nil || strings.Contains(res.Stderr, "can't find session") {
		t.Fatalf("attach with -N: %+v, want a failed connect", res)
	}
	if running(sock) {
		t.Fatal("attach with -N started a tmux server")
	}
	if _, err := os.Stat(sock); err == nil {
		t.Fatal("attach with -N created the socket")
	}
}

// TestAttachNeedsExactName checks that a prefix or a pattern of a live
// session does not attach it. tmux would match both without "=".
func TestAttachNeedsExactName(t *testing.T) {
	srv := newTmux(t, "work", "__tmuxde_clone_ab")
	for _, name := range []string{"wor", "__tmuxde", "__tmuxde*"} {
		t.Run(name, func(t *testing.T) {
			b := srv.attach(t, context.Background(), name, Options{})
			if b.AwaitReady() {
				t.Fatalf("attach %q took", name)
			}
			res := b.Wait()
			if res.SpawnErr == nil || !strings.Contains(res.SpawnErr.Error(), "can't find session") {
				t.Fatalf("attach %q: %+v", name, res)
			}
		})
	}
	b := srv.attach(t, context.Background(), "work", Options{})
	if !b.AwaitReady() {
		t.Fatalf("exact name did not attach: %+v", b.Wait())
	}
}

// procState returns the state letter from /proc/<pid>/stat.
func procState(pid int) (byte, bool) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, false
	}
	i := bytes.LastIndexByte(data, ')')
	if i < 0 || i+2 >= len(data) {
		return 0, false
	}
	return data[i+2], true
}

func firstDiff(a, b string) string {
	n := min(len(a), len(b))
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			lo := max(0, i-20)
			return fmt.Sprintf("first difference at byte %d: got %q, want %q", i, a[lo:min(len(a), i+20)], b[lo:min(len(b), i+20)])
		}
	}
	return fmt.Sprintf("one is a prefix of the other at byte %d", n)
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
