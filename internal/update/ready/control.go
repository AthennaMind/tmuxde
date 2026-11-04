package ready

import (
	"context"
	"io"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
)

// ExitUpdate is reserved for an authorized native update. Normal failures do
// not restart a process or install a staged executable.
const ExitUpdate = 75
const ControlEnvironment = "TMUXDE_UPDATE_CONTROL"

var control string
var updating atomic.Bool
var parentGone <-chan struct{}

// Initialize consumes the private supervisor address before workers can inherit
// it. The supervisor gives each application child a fresh environment.
func Initialize() bool {
	control = os.Getenv(ControlEnvironment)
	_ = os.Unsetenv(ControlEnvironment)
	if control != "" {
		// Descriptor 3 is a private liveness pipe. It must not reach tmux,
		// Git or other worker processes, which could keep it open forever.
		syscall.CloseOnExec(3)
		parent := os.NewFile(3, "supervisor-liveness")
		gone := make(chan struct{})
		parentGone = gone
		go func() {
			_, _ = io.Copy(io.Discard, parent)
			parent.Close()
			close(gone)
		}()
	}
	return control != ""
}

func Control() string {
	return control
}

// Context handles normal shutdown and the supervisor's update request. Only
// the application PID receives the update signal, leaving tmux servers alive.
func Context(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGUSR2)
	go func() {
		defer signal.Stop(signals)
		select {
		case received := <-signals:
			if received == syscall.SIGUSR2 && control != "" {
				updating.Store(true)
			}
			cancel()
		case <-ctx.Done():
		case <-parentGone:
			cancel()
		}
	}()
	return ctx, cancel
}

func ExitCode(code int) int {
	if updating.Load() {
		return ExitUpdate
	}
	return code
}
