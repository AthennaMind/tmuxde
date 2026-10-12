package conns

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// drain waits for the queue with a deadline, so a broken queue fails the
// test instead of hanging it.
func drain(t *testing.T, c *Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := c.Drain(ctx); err != nil {
		t.Fatalf("Drain: %v", err)
	}
}

func TestEnqueue(t *testing.T) {
	t.Run("runs tasks one at a time in order", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		var running, overlap atomic.Int32
		var mu sync.Mutex
		var order []int
		for i := range 100 {
			ok := c.Enqueue(func(context.Context) error {
				if running.Add(1) != 1 {
					overlap.Add(1)
				}
				defer running.Add(-1)
				mu.Lock()
				order = append(order, i)
				mu.Unlock()
				return nil
			})
			if !ok {
				t.Fatalf("Enqueue %d refused", i)
			}
		}
		drain(t, c)
		if overlap.Load() != 0 {
			t.Fatalf("%d tasks overlapped", overlap.Load())
		}
		mu.Lock()
		defer mu.Unlock()
		for i, v := range order {
			if v != i {
				t.Fatalf("order = %v", order)
			}
		}
		if len(order) != 100 {
			t.Fatalf("ran %d tasks, want 100", len(order))
		}
	})

	t.Run("keeps order across goroutines that enqueue at once", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		var running, overlap, ran atomic.Int32
		var wg sync.WaitGroup
		for range 8 {
			wg.Go(func() {
				for range 50 {
					c.Enqueue(func(context.Context) error {
						if running.Add(1) != 1 {
							overlap.Add(1)
						}
						ran.Add(1)
						running.Add(-1)
						return nil
					})
				}
			})
		}
		wg.Wait()
		drain(t, c)
		if overlap.Load() != 0 || ran.Load() != 400 {
			t.Fatalf("ran %d, overlapped %d", ran.Load(), overlap.Load())
		}
	})

	t.Run("is a no-op after SetClosing", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		c.SetClosing()
		if !c.Closing() {
			t.Fatal("Closing() = false")
		}
		var ran atomic.Bool
		if c.Enqueue(func(context.Context) error { ran.Store(true); return nil }) {
			t.Fatal("Enqueue after SetClosing accepted")
		}
		drain(t, c)
		if ran.Load() {
			t.Fatal("task ran after SetClosing")
		}
	})

	t.Run("runs work queued before closing", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		release := make(chan struct{})
		var ran []string
		var mu sync.Mutex
		note := func(s string) {
			mu.Lock()
			ran = append(ran, s)
			mu.Unlock()
		}
		c.Enqueue(func(context.Context) error { <-release; note("first"); return nil })
		c.Enqueue(func(context.Context) error { note("second"); return nil })
		c.SetClosing()
		c.Enqueue(func(context.Context) error { note("late"); return nil })
		close(release)
		drain(t, c)
		mu.Lock()
		defer mu.Unlock()
		if !slices.Equal(ran, []string{"first", "second"}) {
			t.Fatalf("ran %v, want [first second]", ran)
		}
	})

	t.Run("logs a failed task and keeps going", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		var next atomic.Bool
		c.Enqueue(func(context.Context) error { return errors.New("handler blew up") })
		c.Enqueue(func(context.Context) error { next.Store(true); return nil })
		drain(t, c)
		if !next.Load() {
			t.Fatal("task after the failed one did not run")
		}
		if logs := e.logs.String(); !strings.Contains(logs, "queued task failed") || !strings.Contains(logs, "handler blew up") {
			t.Fatalf("failure not logged: %s", logs)
		}
	})

	t.Run("recovers a panicking task and keeps going", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		var next atomic.Bool
		c.Enqueue(func(context.Context) error { panic("handler blew up") })
		c.Enqueue(func(context.Context) error { next.Store(true); return nil })
		drain(t, c)
		if !next.Load() {
			t.Fatal("task after the panicking one did not run")
		}
		if logs := e.logs.String(); !strings.Contains(logs, "queued task panicked") || !strings.Contains(logs, "handler blew up") {
			t.Fatalf("panic not logged: %s", logs)
		}
	})

	t.Run("restarts after the queue went idle", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		var ran atomic.Int32
		c.Enqueue(func(context.Context) error { ran.Add(1); return nil })
		drain(t, c)
		c.Enqueue(func(context.Context) error { ran.Add(1); return nil })
		drain(t, c)
		if ran.Load() != 2 {
			t.Fatalf("ran %d, want 2", ran.Load())
		}
	})

	t.Run("cancels running work and drops the rest on remove", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		started := make(chan struct{})
		var cause error
		var dropped atomic.Bool
		c.Enqueue(func(ctx context.Context) error {
			close(started)
			<-ctx.Done()
			cause = ctx.Err()
			return cause
		})
		c.Enqueue(func(context.Context) error { dropped.Store(true); return nil })
		<-started
		e.reg.Remove(c.ID())
		drain(t, c)
		if !errors.Is(cause, context.Canceled) {
			t.Fatalf("task saw %v, want context.Canceled", cause)
		}
		if dropped.Load() {
			t.Fatal("queued task ran after Remove")
		}
		if c.Enqueue(func(context.Context) error { return nil }) {
			t.Fatal("Enqueue after Remove accepted")
		}
		if logs := e.logs.String(); strings.Contains(logs, "queued task failed") {
			t.Fatalf("cancellation logged as failure: %s", logs)
		}
	})
}

func TestDrain(t *testing.T) {
	t.Run("returns at once when idle", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		// A done ctx proves Drain did not wait: it would return ctx.Err().
		if err := c.Drain(ctx); err != nil {
			t.Fatalf("Drain on an idle queue = %v", err)
		}
	})

	t.Run("waits for work in flight", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		started := make(chan struct{})
		release := make(chan struct{})
		var finished atomic.Bool
		c.Enqueue(func(context.Context) error {
			close(started)
			<-release
			finished.Store(true)
			return nil
		})
		<-started
		c.SetClosing()

		// While the task is blocked, Drain can only end by its deadline.
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
		defer cancel()
		if err := c.Drain(ctx); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Drain with work in flight = %v, want DeadlineExceeded", err)
		}
		if finished.Load() {
			t.Fatal("task finished before release")
		}

		close(release)
		drain(t, c)
		if !finished.Load() {
			t.Fatal("Drain returned before the task finished")
		}
	})
}
