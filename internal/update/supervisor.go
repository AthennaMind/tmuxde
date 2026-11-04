package update

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"tmuxde/internal/update/ready"
)

type childProcess struct {
	command  *exec.Cmd
	liveness *os.File
	done     chan struct{}
	code     int
}

var errInstallationBusy = errors.New("another process is updating this executable")

type supervisor struct {
	mu       sync.Mutex
	binary   string
	args     []string
	env      []string
	stdin    io.Reader
	stdout   io.Writer
	stderr   io.Writer
	socket   string
	dir      string
	lock     *os.File
	reason   string
	child    *childProcess
	pending  string
	requests chan string
}

// Supervise owns native application children. External service managers see one
// stable parent PID. A normal exit propagates unchanged. Only ExitUpdate with a
// matching authorized transaction can replace an executable and restart it.
func Supervise(args []string, defaultServe bool, stdin io.Reader, stdout, stderr io.Writer) (int, bool) {
	if ready.Initialize() {
		return 0, false
	}
	application := defaultServe && len(args) == 0
	if len(args) == 1 && (args[0] == "serve" || args[0] == "agent") {
		application = true
	}
	if !application || inContainer() {
		return 0, false
	}
	binary, err := os.Executable()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1, true
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		cancel()
	}()
	s := &supervisor{
		binary:   binary,
		args:     args,
		env:      os.Environ(),
		stdin:    stdin,
		stdout:   stdout,
		stderr:   stderr,
		dir:      filepath.Join(filepath.Dir(binary), "."+filepath.Base(binary)+"-update"),
		requests: make(chan string, 1),
	}
	return s.run(ctx), true
}

func (s *supervisor) run(ctx context.Context) int {
	socketDir, err := os.MkdirTemp("", "tmuxde-supervisor-*")
	if err != nil {
		fmt.Fprintln(s.stderr, err)
		return 1
	}
	defer os.RemoveAll(socketDir)
	s.socket = filepath.Join(socketDir, "control.sock")
	listener, err := net.Listen("unix", s.socket)
	if err != nil {
		fmt.Fprintln(s.stderr, err)
		return 1
	}
	defer listener.Close()
	server := &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		MaxHeaderBytes:    4096,
	}
	defer server.Close()
	if err := s.reserve(); err != nil {
		if errors.Is(err, errInstallationBusy) {
			fmt.Fprintln(s.stderr, err)
			return 1
		}
		s.reason = err.Error()
	} else {
		defer s.lock.Close()
	}
	go func() {
		_ = server.Serve(listener)
	}()
	defer s.stopChild()
	if err := s.recover(ctx); err != nil {
		fmt.Fprintln(s.stderr, "update recovery:", err)
		return 1
	}
	if s.current() == nil {
		if err := s.start(); err != nil {
			fmt.Fprintln(s.stderr, err)
			return 1
		}
	}
	var shutdownTimer *time.Timer
	var shutdownDeadline <-chan time.Time
	defer func() {
		if shutdownTimer != nil {
			shutdownTimer.Stop()
		}
	}()
	for {
		child := s.current()
		select {
		case <-ctx.Done():
			s.stopChild()
			s.abortPending("Application stopped before update shutdown completed")
			return 0
		case <-s.requests:
			if err := child.command.Process.Signal(syscall.SIGUSR2); err != nil {
				fmt.Fprintln(s.stderr, "update shutdown:", err)
			}
			shutdownTimer = time.NewTimer(30 * time.Second)
			shutdownDeadline = shutdownTimer.C
		case <-shutdownDeadline:
			_ = child.command.Process.Kill()
			<-child.done
			s.abortPending("Application did not finish graceful update shutdown")
			shutdownDeadline = nil
			if err := s.start(); err != nil {
				fmt.Fprintln(s.stderr, err)
				return 1
			}
		case <-child.done:
			if shutdownTimer != nil {
				shutdownTimer.Stop()
				shutdownDeadline = nil
			}
			s.mu.Lock()
			id := s.pending
			s.mu.Unlock()
			if child.code != ready.ExitUpdate || id == "" || ctx.Err() != nil {
				s.abortPending("Application exited without update exit code")
				return child.code
			}
			if err := s.install(ctx, id); err != nil {
				fmt.Fprintln(s.stderr, "update:", err)
				return 1
			}
		}
	}
}

func (s *supervisor) abortPending(message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending == "" {
		return
	}
	lock, err := transactionLock(s.dir)
	if err != nil {
		return
	}
	defer lock.Close()
	journal := filepath.Join(s.dir, s.pending+".json")
	var tx transaction
	if read(journal, &tx) == nil && tx.Result.Phase == "starting" {
		tx.Result = Result{Phase: "failed", Message: message}
		tx.Updated = time.Now().UTC()
		if save(journal, tx) == nil {
			os.Remove(filepath.Join(s.dir, "reservation"))
			os.Remove(filepath.Join(s.dir, s.pending+".candidate"))
		}
	}
	s.pending = ""
	s.shared()
}

func (s *supervisor) reserve() error {
	if err := os.Mkdir(s.dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return errors.New("binary directory is not writable")
	}
	if err := validateDirectory(s.dir); err != nil {
		return err
	}
	guard, err := transactionLock(s.dir)
	if err != nil {
		return errInstallationBusy
	}
	defer guard.Close()
	lock, err := os.OpenFile(filepath.Join(s.dir, "running"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_SH|syscall.LOCK_NB); err != nil {
		lock.Close()
		return errInstallationBusy
	}
	s.lock = lock
	return nil
}

func (s *supervisor) exclusive() error {
	if s.lock == nil {
		return errors.New("binary directory is not writable")
	}
	if err := syscall.Flock(int(s.lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		// Lock conversion may drop shared ownership. Callers hold the
		// transaction lock so another supervisor cannot upgrade meanwhile.
		s.shared()
		return errors.New("manual update required for shared executable")
	}
	return nil
}

func (s *supervisor) shared() {
	if s.lock != nil {
		_ = syscall.Flock(int(s.lock.Fd()), syscall.LOCK_SH)
	}
}

func (s *supervisor) current() *childProcess {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.child
}

func (s *supervisor) start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cmd := exec.Command(s.binary, s.args...)
	cmd.Stdin = s.stdin
	cmd.Stdout = s.stdout
	cmd.Stderr = s.stderr
	for _, entry := range s.env {
		if !strings.HasPrefix(entry, ready.ControlEnvironment+"=") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, ready.ControlEnvironment+"="+s.socket)
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd.ExtraFiles = []*os.File{reader}
	if err := cmd.Start(); err != nil {
		reader.Close()
		writer.Close()
		return err
	}
	reader.Close()
	child := &childProcess{
		command:  cmd,
		liveness: writer,
		done:     make(chan struct{}),
	}
	s.child = child
	go func() {
		defer writer.Close()
		err := cmd.Wait()
		child.code = cmd.ProcessState.ExitCode()
		if err != nil && child.code < 0 {
			child.code = 1
			if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				child.code = 128 + int(status.Signal())
			}
		}
		close(child.done)
	}()
	return nil
}

func (s *supervisor) stopChild() {
	child := s.current()
	if child == nil {
		return
	}
	select {
	case <-child.done:
		return
	default:
	}
	_ = child.command.Process.Signal(syscall.SIGTERM)
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case <-child.done:
	case <-timer.C:
		_ = child.command.Process.Kill()
		<-child.done
	}
}

func (s *supervisor) prepare(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reason != "" {
		return errors.New(s.reason)
	}
	if s.pending != "" {
		return errors.New("an update is already in progress")
	}
	lock, err := transactionLock(s.dir)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := s.exclusive(); err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			s.shared()
		}
	}()
	var tx transaction
	if err := read(filepath.Join(s.dir, id+".json"), &tx); err != nil {
		return err
	}
	if tx.ID != id || tx.Binary != s.binary || tx.Result.Phase != "staged" {
		return errors.New("transaction is not staged for this executable")
	}
	tx.Result = Result{Phase: "starting"}
	tx.Updated = time.Now().UTC()
	if err := save(filepath.Join(s.dir, id+".json"), tx); err != nil {
		return err
	}
	s.pending = id
	ok = true
	return nil
}

func (s *supervisor) recover(ctx context.Context) error {
	if s.reason != "" {
		return nil
	}
	reservation, err := readReservation(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errors.New("invalid update reservation")
	}
	var tx transaction
	if err := read(filepath.Join(s.dir, reservation+".json"), &tx); err != nil {
		// A crash during staging cannot authorize installation.
		return nil
	}
	switch tx.Result.Phase {
	case "starting", "installing", "restarting", "rolling-back":
		if err := waitPreviousChild(ctx, s.dir, &tx); err != nil {
			return err
		}
		guard, err := transactionLock(s.dir)
		if err != nil {
			return err
		}
		if err := s.exclusive(); err != nil {
			guard.Close()
			return err
		}
		s.mu.Lock()
		s.pending = reservation
		s.mu.Unlock()
		guard.Close()
		return s.install(ctx, reservation)
	default:
		return nil
	}
}

func waitPreviousChild(ctx context.Context, dir string, tx *transaction) error {
	pid := tx.PID
	var receipt ready.Receipt
	if read(filepath.Join(dir, tx.ID+".ready"), &receipt) == nil {
		if receipt.Digest == tx.CandidateDigest || receipt.Digest == tx.PreviousDigest {
			pid = receipt.PID
		}
	}
	if pid <= 1 {
		return nil
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return nil
	}
	defer func() {
		_ = process.Release()
	}()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for process.Signal(syscall.Signal(0)) == nil {
		select {
		case <-ctx.Done():
			return errors.New("previous application process has not stopped; retry startup after it exits")
		case <-ticker.C:
		}
	}
	return nil
}

func (s *supervisor) install(ctx context.Context, id string) error {
	lock, err := transactionLock(s.dir)
	if err != nil {
		return err
	}
	defer lock.Close()
	journal := filepath.Join(s.dir, id+".json")
	var tx transaction
	if err := read(journal, &tx); err != nil {
		return err
	}
	if tx.ID != id || tx.Binary != s.binary {
		return errors.New("invalid update journal")
	}
	s.mu.Lock()
	s.pending = id
	s.mu.Unlock()
	report := func(phase, message string) error {
		tx.Result = Result{Phase: phase, Message: message}
		tx.Updated = time.Now().UTC()
		return save(journal, tx)
	}
	engine := installer{
		restart: func(context.Context, string) error {
			s.stopChild()
			return s.start()
		},
		wait: s.waitReady,
	}
	err = engine.install(ctx, s.dir, &tx, report)
	if err != nil && tx.Result.Phase == "updated" {
		// New child confirmed startup, but journal could not be committed.
		// Keep it serving and retain reservation for explicit recovery.
		fmt.Fprintln(s.stderr, "update journal:", err)
		return nil
	}
	if err != nil && tx.Result.Phase != "rolled-back" && tx.Result.Phase != "rollback-failed" {
		installed, hashErr := fileDigest(s.binary)
		if hashErr == nil && installed == tx.PreviousDigest {
			s.stopChild()
			restored := tx
			restored.Version = tx.PreviousVersion
			restored.CandidateDigest = tx.PreviousDigest
			startErr := s.start()
			if startErr == nil {
				startErr = s.waitReady(context.WithoutCancel(ctx), s.dir, &restored, 3*time.Minute)
			}
			if startErr != nil {
				_ = report("rollback-failed", "Update failed before replacement and previous application could not restart")
				return errors.Join(err, startErr)
			}
		}
		if writeErr := report("failed", err.Error()); writeErr != nil {
			return errors.Join(err, writeErr)
		}
		if hashErr == nil && installed == tx.PreviousDigest {
			err = nil
		}
	}
	if tx.Result.Phase == "rollback-failed" {
		return err
	}
	if removeErr := os.Remove(filepath.Join(s.dir, "reservation")); removeErr != nil {
		return removeErr
	}
	s.mu.Lock()
	s.pending = ""
	s.shared()
	s.mu.Unlock()
	if tx.Result.Phase == "rolled-back" {
		return nil
	}
	return err
}

func (s *supervisor) waitReady(ctx context.Context, dir string, tx *transaction, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	child := s.current()
	if child == nil {
		return errors.New("application did not start")
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		var receipt ready.Receipt
		if read(filepath.Join(dir, tx.ID+".ready"), &receipt) == nil {
			if receipt.PID == child.command.Process.Pid && receipt.Digest == tx.CandidateDigest && version(receipt.Version) == version(tx.Version) {
				select {
				case <-child.done:
					return errors.New("application exited during startup")
				default:
					return nil
				}
			}
		}
		select {
		case <-child.done:
			return errors.New("application exited before confirming startup")
		case <-ctx.Done():
			return errors.New("application did not confirm healthy startup")
		case <-ticker.C:
		}
	}
}
