package dictation

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"
)

// eventually polls cond until it holds or waitLimit passes.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitLimit)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("gave up waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func waitStopped(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(waitLimit):
		t.Fatal("probe did not stop")
	}
}

// TestProbe ports "speech service probe" from dictation.test.ts.
func TestProbe(t *testing.T) {
	t.Run("offers dictation while the service is healthy", func(t *testing.T) {
		f := startFake(t, fakeOptions{health: http.StatusOK})
		var logs logBuffer
		// Hour long intervals: only the first check, which runs at once,
		// can turn it on.
		b := newBridge(t, Options{
			SocketPath: f.path,
			Logger:     slog.New(slog.NewTextHandler(&logs, nil)),
			ProbeUp:    time.Hour,
			ProbeDown:  time.Hour,
		})
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := b.StartProbe(ctx)
		eventually(t, "dictation to be offered", b.Available)
		cancel()
		if b.Available() {
			t.Error("still offered after the probe stopped")
		}
		waitStopped(t, done)
		if b.Available() {
			t.Error("offered after the probe ended")
		}
		if got := strings.Count(logs.String(), "Speech service availability changed"); got != 1 {
			t.Errorf("logged %d availability changes, want 1:\n%s", got, logs.String())
		}
	})

	t.Run("withholds dictation while the service is unhealthy", func(t *testing.T) {
		f := startFake(t, fakeOptions{health: http.StatusServiceUnavailable})
		b := newBridge(t, Options{SocketPath: f.path, ProbeUp: time.Hour, ProbeDown: 5 * time.Millisecond})
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := b.StartProbe(ctx)
		// A second hit means the first answer was recorded.
		eventually(t, "two health checks", func() bool { return f.healthHits.Load() >= 2 })
		if b.Available() {
			t.Error("offered while the service answers 503")
		}
		// ProbeDown applies while down, so recovery shows up quickly.
		f.health.Store(http.StatusNoContent)
		eventually(t, "dictation to be offered", b.Available)
		cancel()
		waitStopped(t, done)
	})

	t.Run("does nothing without a configured service", func(t *testing.T) {
		b := newBridge(t, Options{})
		done := b.StartProbe(context.Background())
		select {
		case <-done:
		default:
			t.Fatal("probe without a service did not finish at once")
		}
		if b.Available() {
			t.Error("offered without a service")
		}
	})
}

func TestProbeLifecycle(t *testing.T) {
	t.Run("a stopped probe never writes the flag", func(t *testing.T) {
		f := startFake(t, fakeOptions{health: http.StatusServiceUnavailable})
		var logs logBuffer
		b := newBridge(t, Options{
			SocketPath: f.path,
			Logger:     slog.New(slog.NewTextHandler(&logs, nil)),
			ProbeUp:    time.Hour,
			ProbeDown:  time.Hour,
		})
		ctx, cancel := context.WithCancel(context.Background())
		done := b.StartProbe(ctx)
		eventually(t, "a health check", func() bool { return f.healthHits.Load() >= 1 })
		b.probe.mu.Lock()
		gen := b.probe.gen
		b.probe.mu.Unlock()
		cancel()
		// A check that was in flight at stop comes back healthy.
		b.record(ctx, gen, true)
		waitStopped(t, done)
		b.record(ctx, gen, true)
		b.probe.mu.Lock()
		up := b.probe.up
		b.probe.mu.Unlock()
		if up || b.Available() {
			t.Error("a stopped probe turned dictation on")
		}
		if strings.Contains(logs.String(), "availability changed") {
			t.Errorf("a stopped probe logged a change:\n%s", logs.String())
		}
	})

	t.Run("runs one probe at a time and starts again after a stop", func(t *testing.T) {
		f := startFake(t, fakeOptions{health: http.StatusOK})
		b := newBridge(t, Options{SocketPath: f.path, ProbeUp: time.Hour, ProbeDown: time.Hour})
		ctx, cancel := context.WithCancel(context.Background())
		first := b.StartProbe(ctx)
		if again := b.StartProbe(context.Background()); again != first {
			t.Error("a second start while running started another probe")
		}
		eventually(t, "dictation to be offered", b.Available)
		cancel()
		waitStopped(t, first)

		ctx2, cancel2 := context.WithCancel(context.Background())
		defer cancel2()
		second := b.StartProbe(ctx2)
		if second == first {
			t.Fatal("start after stop returned the old probe")
		}
		eventually(t, "dictation to be offered again", b.Available)
		cancel2()
		waitStopped(t, second)
		if b.Available() {
			t.Error("offered after the second probe stopped")
		}
	})
}
