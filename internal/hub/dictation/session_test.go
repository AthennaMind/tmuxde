package dictation

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/protocol/server"
)

// hello is "Zdravei" in Cyrillic, written as escapes.
const hello = "\u0417\u0434\u0440\u0430\u0432\u0435\u0439"

func wantError(t *testing.T, got server.Message, id, code, text string) {
	t.Helper()
	want := &server.DictationError{Type: "dictation:error", ID: id, Code: code, Message: text}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %s, want %s", describe([]server.Message{got}), describe([]server.Message{want}))
	}
}

func wantSent(t *testing.T, r *recorder, want ...server.Message) {
	t.Helper()
	if got := r.messages(); !reflect.DeepEqual(got, want) {
		t.Fatalf("sent %s, want %s", describe(got), describe(want))
	}
}

func wantIdle(t *testing.T, s *Session) {
	t.Helper()
	if id := running(s); id != "" {
		t.Fatalf("dictation %q still in the slot", id)
	}
}

func ready(id string) server.Message {
	return &server.DictationReady{Type: "dictation:ready", ID: id}
}

// TestForwarding ports "dictation forwarding" from dictation.test.ts.
func TestForwarding(t *testing.T) {
	ctx := context.Background()

	t.Run("says unavailable when dictation is not configured", func(t *testing.T) {
		b := newBridge(t, Options{})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		msgs := r.messages()
		if len(msgs) != 1 {
			t.Fatalf("sent %s, want one error", describe(msgs))
		}
		wantError(t, msgs[0], "d1", server.DictationUnavailable, "Dictation is not enabled on this machine")
		wantIdle(t, s)
	})

	t.Run("says unavailable when the service cannot be reached", func(t *testing.T) {
		tests := []struct {
			name  string
			setup func(t *testing.T) Options
		}{
			{
				name: "no listener",
				setup: func(t *testing.T) Options {
					f := startFake(t, fakeOptions{})
					f.stop()
					return Options{SocketPath: f.path}
				},
			},
			{
				name: "upgrade answered 404",
				setup: func(t *testing.T) Options {
					f := startFake(t, fakeOptions{rejectUpgrade: true})
					return Options{SocketPath: f.path}
				},
			},
			{
				name: "handshake times out",
				setup: func(t *testing.T) Options {
					path := socketPath(t)
					ln, err := net.Listen("unix", path)
					if err != nil {
						t.Fatal(err)
					}
					// Accepts and never answers.
					go func() {
						for {
							c, err := ln.Accept()
							if err != nil {
								return
							}
							t.Cleanup(func() { c.Close() })
						}
					}()
					t.Cleanup(func() { ln.Close() })
					return Options{SocketPath: path, ConnectTimeout: 50 * time.Millisecond}
				},
			},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				b := newBridge(t, tt.setup(t))
				s := newSession(t, b)
				r := newRecorder(t)
				s.Start(ctx, "d1", r.send)
				wantError(t, r.until("dictation:error", "d1"), "d1", server.DictationUnavailable, "Speech service is not reachable")
				wantIdle(t, s)
			})
		}
	})

	t.Run("forwards audio and stop, then relays text and done", func(t *testing.T) {
		f := startFake(t, fakeOptions{onSession: func(fs *fakeSession) {
			sendReady(fs)
			if !fs.waitFor(func() bool { return len(fs.text) > 0 }) {
				return
			}
			fs.sendText(`{"type":"text","text":"\u0417\u0434\u0440\u0430\u0432\u0435\u0439"}`)
			fs.sendText(`{"type":"done"}`)
			fs.conn.Close(websocket.StatusNormalClosure, "done")
		}})
		b := newBridge(t, Options{SocketPath: f.path})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		r.until("dictation:ready", "d1")
		r.reply(s.Audio("d1", []byte{1, 0, 2, 0}))
		r.reply(s.Stop("d1"))
		r.until("dictation:done", "d1")
		wantSent(t, r,
			ready("d1"),
			&server.DictationText{Type: "dictation:text", ID: "d1", Text: hello},
			&server.DictationDone{Type: "dictation:done", ID: "d1"},
		)
		wantIdle(t, s)
		fs := f.session(t, 0)
		bin, text := fs.frames()
		if got := bytes.Join(bin, nil); !bytes.Equal(got, []byte{1, 0, 2, 0}) {
			t.Errorf("service got audio %v, want [1 0 2 0]", got)
		}
		if want := []string{`{"type":"stop"}`}; !reflect.DeepEqual(text, want) {
			t.Errorf("service got text %q, want %q", text, want)
		}
	})

	t.Run("holds audio sent before the service connection opens", func(t *testing.T) {
		f := startFake(t, fakeOptions{})
		gate := make(chan struct{})
		b := newBridge(t, Options{SocketPath: f.path, Dial: gatedDial(f.path, gate)})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		r.reply(s.Audio("d1", []byte{1, 0}))
		r.reply(s.Audio("d1", []byte{2, 0}))
		r.reply(s.Stop("d1"))
		close(gate)
		r.until("dictation:ready", "d1")
		fs := f.session(t, 0)
		fs.mustWait(t, "stop", func() bool { return len(fs.text) == 1 })
		bin, text := fs.frames()
		if want := [][]byte{{1, 0}, {2, 0}}; !reflect.DeepEqual(bin, want) {
			t.Errorf("service got audio %v, want %v as separate messages", bin, want)
		}
		if want := []string{`{"type":"stop"}`}; !reflect.DeepEqual(text, want) {
			t.Errorf("service got text %q, want %q", text, want)
		}
		wantSent(t, r, ready("d1"))
	})

	t.Run("reports a busy service", func(t *testing.T) {
		f := startFake(t, fakeOptions{onSession: func(fs *fakeSession) {
			fs.conn.Close(websocket.StatusTryAgainLater, "Busy")
		}})
		b := newBridge(t, Options{SocketPath: f.path})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		wantError(t, r.until("dictation:error", "d1"), "d1", server.DictationBusy, "Speech service is busy. Try again shortly.")
		wantIdle(t, s)
	})

	t.Run("passes a service error on as failed", func(t *testing.T) {
		f := startFake(t, fakeOptions{onSession: func(fs *fakeSession) {
			fs.sendText(`{"type":"error","code":"DECODE_FAILED","message":"Speech could not be transcribed"}`)
			fs.conn.Close(websocket.StatusInternalError, "DECODE_FAILED")
		}})
		b := newBridge(t, Options{SocketPath: f.path})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		wantError(t, r.until("dictation:error", "d1"), "d1", server.DictationFailed, "Speech could not be transcribed")
		// The close that follows says nothing more.
		f.session(t, 0).closed(t)
		waitGoroutines(t, b)
		if n := len(r.messages()); n != 1 {
			t.Errorf("sent %s, want one error", describe(r.messages()))
		}
	})

	t.Run("does not trust malformed service messages", func(t *testing.T) {
		f := startFake(t, fakeOptions{onSession: func(fs *fakeSession) {
			fs.sendText(`{"type":"text","text":42}`)
		}})
		b := newBridge(t, Options{SocketPath: f.path})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		wantError(t, r.until("dictation:error", "d1"), "d1", server.DictationFailed, "Speech service sent nonsense")
		for _, m := range r.messages() {
			if m.WireType() == "dictation:text" {
				t.Errorf("malformed text reached the browser: %s", describe([]server.Message{m}))
			}
		}
		wantIdle(t, s)
	})

	t.Run("answers audio for a dictation that is not running", func(t *testing.T) {
		f := startFake(t, fakeOptions{onSession: func(fs *fakeSession) {
			sendReady(fs)
			fs.sendText(`{"type":"done"}`)
		}})
		b := newBridge(t, Options{SocketPath: f.path})
		s := newSession(t, b)
		r := newRecorder(t)

		notFound := func(id string) *server.DictationError {
			return &server.DictationError{Type: "dictation:error", ID: id, Code: server.DictationNotFound, Message: "No dictation is running"}
		}
		tests := []struct {
			name string
			call func() server.Message
			id   string
		}{
			{"audio with nothing started", func() server.Message { return s.Audio("nope", []byte{0, 0}) }, "nope"},
			{"stop with nothing started", func() server.Message { return s.Stop("nope") }, "nope"},
		}
		for _, tt := range tests {
			if got := tt.call(); !reflect.DeepEqual(got, server.Message(notFound(tt.id))) {
				t.Errorf("%s: got %s, want NOT_FOUND", tt.name, describe([]server.Message{got}))
			}
		}
		wantSent(t, r)

		// After done, every frame gets its own NOT_FOUND.
		s.Start(ctx, "d1", r.send)
		r.until("dictation:done", "d1")
		for range 2 {
			if got := s.Audio("d1", []byte{0, 0}); !reflect.DeepEqual(got, server.Message(notFound("d1"))) {
				t.Errorf("audio after done: got %v, want NOT_FOUND", got)
			}
			if got := s.Stop("d1"); !reflect.DeepEqual(got, server.Message(notFound("d1"))) {
				t.Errorf("stop after done: got %v, want NOT_FOUND", got)
			}
		}
		// Audio for another id while one runs.
		s.Start(ctx, "d2", r.send)
		if got := s.Audio("d1", []byte{0, 0}); !reflect.DeepEqual(got, server.Message(notFound("d1"))) {
			t.Errorf("audio for another id: got %v, want NOT_FOUND", got)
		}
		r.until("dictation:done", "d2")
	})

	t.Run("cancels quietly and closes the service session", func(t *testing.T) {
		f := startFake(t, fakeOptions{})
		b := newBridge(t, Options{SocketPath: f.path})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		r.until("dictation:ready", "d1")
		s.Cancel("d1", false)
		if code := f.session(t, 0).closed(t); code != websocket.StatusNormalClosure {
			t.Errorf("service stream closed with %v, want 1000", code)
		}
		wantIdle(t, s)
		waitGoroutines(t, b)
		wantSent(t, r, ready("d1"))
	})

	t.Run("ignores a cancel for another dictation", func(t *testing.T) {
		f := startFake(t, fakeOptions{})
		b := newBridge(t, Options{SocketPath: f.path})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d2", r.send)
		r.until("dictation:ready", "d2")
		s.Cancel("d1", false)
		if id := running(s); id != "d2" {
			t.Fatalf("running %q, want d2", id)
		}
	})

	t.Run("replaces a running dictation when a new one starts", func(t *testing.T) {
		f := startFake(t, fakeOptions{})
		b := newBridge(t, Options{SocketPath: f.path})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		r.until("dictation:ready", "d1")
		s.Start(ctx, "d2", r.send)
		if code := f.session(t, 0).closed(t); code != websocket.StatusNormalClosure {
			t.Errorf("old service stream closed with %v, want 1000", code)
		}
		if id := running(s); id != "d2" {
			t.Fatalf("running %q, want d2", id)
		}
		r.until("dictation:ready", "d2")
		// The old id got nothing for its end.
		wantSent(t, r, ready("d1"), ready("d2"))
	})

	t.Run("ends a dictation that runs past its limit", func(t *testing.T) {
		f := startFake(t, fakeOptions{})
		b := newBridge(t, Options{SocketPath: f.path, MaxSession: 30 * time.Millisecond})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		wantError(t, r.until("dictation:error", "d1"), "d1", server.DictationFailed, "Dictation ran too long")
		wantIdle(t, s)
	})
}

func TestStreamEnds(t *testing.T) {
	ctx := context.Background()

	t.Run("drops audio after stop", func(t *testing.T) {
		f := startFake(t, fakeOptions{})
		b := newBridge(t, Options{SocketPath: f.path})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		r.until("dictation:ready", "d1")
		r.reply(s.Stop("d1"))
		r.reply(s.Audio("d1", []byte{1, 0}))
		r.reply(s.Stop("d1"))
		fs := f.session(t, 0)
		// End drops frames still queued, so let the stop arrive first.
		fs.mustWait(t, "stop", func() bool { return len(fs.text) > 0 })
		s.Cancel("d1", false)
		fs.closed(t)
		bin, text := fs.frames()
		if len(bin) != 0 {
			t.Errorf("service got audio after stop: %v", bin)
		}
		if want := []string{`{"type":"stop"}`}; !reflect.DeepEqual(text, want) {
			t.Errorf("service got text %q, want one stop", text)
		}
		wantSent(t, r, ready("d1"))
	})

	t.Run("ignores binary messages from the service", func(t *testing.T) {
		f := startFake(t, fakeOptions{onSession: func(fs *fakeSession) {
			ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
			defer cancel()
			_ = fs.conn.Write(ctx, websocket.MessageBinary, []byte("{}"))
			sendReady(fs)
		}})
		b := newBridge(t, Options{SocketPath: f.path})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		r.until("dictation:ready", "d1")
		s.Cancel("d1", false)
		f.session(t, 0).closed(t)
		wantSent(t, r, ready("d1"))
	})

	t.Run("closes the service session when the connection goes away", func(t *testing.T) {
		f := startFake(t, fakeOptions{})
		b := newBridge(t, Options{SocketPath: f.path})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		r.until("dictation:ready", "d1")
		s.Close()
		if code := f.session(t, 0).closed(t); code != websocket.StatusNormalClosure {
			t.Errorf("service stream closed with %v, want 1000", code)
		}
		wantIdle(t, s)

		// A start that raced the disconnect does nothing.
		s.Start(ctx, "d2", r.send)
		wantIdle(t, s)
		waitGoroutines(t, b)
		if n := f.count(); n != 1 {
			t.Errorf("service got %d streams, want 1", n)
		}
		wantSent(t, r, ready("d1"))
	})

	t.Run("closes a connecting session when the connection goes away", func(t *testing.T) {
		f := startFake(t, fakeOptions{})
		gate := make(chan struct{})
		b := newBridge(t, Options{SocketPath: f.path, Dial: gatedDial(f.path, gate)})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		r.reply(s.Audio("d1", []byte{1, 0}))
		s.Close()
		close(gate)
		waitGoroutines(t, b)
		if n := f.count(); n != 0 {
			t.Errorf("service got %d streams, want none", n)
		}
		wantSent(t, r)
	})

	// Remove cancels the connection context before it runs the close
	// hooks, so the dial can see the cancel before Close comes.
	t.Run("stays quiet when the connection context ends during the dial", func(t *testing.T) {
		started := make(chan struct{})
		var logs logBuffer
		b := newBridge(t, Options{
			SocketPath: "unused",
			Logger:     slog.New(slog.NewTextHandler(&logs, nil)),
			Dial: func(ctx context.Context) (net.Conn, error) {
				close(started)
				<-ctx.Done()
				return nil, ctx.Err()
			},
		})
		s := newSession(t, b)
		r := newRecorder(t)
		connCtx, cancel := context.WithCancel(ctx)
		s.Start(connCtx, "d1", r.send)
		select {
		case <-started:
		case <-time.After(waitLimit):
			t.Fatal("dial never started")
		}
		cancel()
		waitGoroutines(t, b)
		wantIdle(t, s)
		s.Close()
		wantSent(t, r)
		if strings.Contains(logs.String(), "level=WARN") {
			t.Errorf("logged a warning:\n%s", logs.String())
		}
	})

	tests := []struct {
		name      string
		opts      Options
		onSession func(fs *fakeSession)
		code      string
		text      string
	}{
		{
			name: "close with another code",
			onSession: func(fs *fakeSession) {
				sendReady(fs)
				fs.conn.Close(websocket.StatusInternalError, "IDLE")
			},
			code: server.DictationFailed,
			text: "Speech service closed the connection",
		},
		{
			name: "drop without a close frame",
			onSession: func(fs *fakeSession) {
				sendReady(fs)
				fs.conn.CloseNow()
			},
			code: server.DictationFailed,
			text: "Speech service closed the connection",
		},
		{
			name: "message over the read limit",
			opts: Options{ReadLimit: 64},
			onSession: func(fs *fakeSession) {
				sendReady(fs)
				fs.sendText(`{"type":"text","text":"` + strings.Repeat("a", 100) + `"}`)
			},
			code: server.DictationFailed,
			text: "Lost the speech service",
		},
		{
			name: "text over the limit",
			opts: Options{MaxText: 4},
			onSession: func(fs *fakeSession) {
				sendReady(fs)
				fs.sendText(`{"type":"text","text":"abcde"}`)
			},
			code: server.DictationFailed,
			text: "Speech service sent nonsense",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := startFake(t, fakeOptions{onSession: tt.onSession})
			opts := tt.opts
			opts.SocketPath = f.path
			b := newBridge(t, opts)
			s := newSession(t, b)
			r := newRecorder(t)
			s.Start(ctx, "d1", r.send)
			wantError(t, r.until("dictation:error", "d1"), "d1", tt.code, tt.text)
			wantIdle(t, s)
			wantSent(t, r, ready("d1"), r.until("dictation:error", "d1"))
		})
	}
}

func TestBuffering(t *testing.T) {
	ctx := context.Background()

	t.Run("fails when audio piles up while connecting", func(t *testing.T) {
		f := startFake(t, fakeOptions{})
		gate := make(chan struct{})
		b := newBridge(t, Options{SocketPath: f.path, Dial: gatedDial(f.path, gate), MaxBuffered: 8})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		r.reply(s.Audio("d1", []byte{1, 0, 1, 0}))
		r.reply(s.Audio("d1", []byte{2, 0, 2, 0}))
		wantSent(t, r) // 8 bytes is at the cap, not over it
		r.reply(s.Audio("d1", []byte{3, 0, 3, 0}))
		wantError(t, r.until("dictation:error", "d1"), "d1", server.DictationOverloaded, "Speech service is not keeping up")
		wantIdle(t, s)
		r.reply(s.Audio("d1", []byte{4, 0}))
		close(gate)
		waitGoroutines(t, b)
		if n := f.count(); n != 0 {
			t.Errorf("service got %d streams after the failure, want none", n)
		}
		msgs := r.messages()
		if len(msgs) != 2 {
			t.Fatalf("sent %s, want OVERLOADED then NOT_FOUND", describe(msgs))
		}
		wantError(t, msgs[1], "d1", server.DictationNotFound, "No dictation is running")
	})

	t.Run("fails when the open queue passes the cap", func(t *testing.T) {
		f := startFake(t, fakeOptions{})
		var hold atomic.Bool
		release := make(chan struct{})
		dial := func(ctx context.Context) (net.Conn, error) {
			c, err := dialUnix(ctx, f.path)
			if err != nil {
				return nil, err
			}
			return &holdConn{Conn: c, hold: &hold, release: release}, nil
		}
		b := newBridge(t, Options{SocketPath: f.path, Dial: dial, MaxBuffered: 10})
		var once atomic.Bool
		t.Cleanup(func() {
			if once.CompareAndSwap(false, true) {
				close(release)
			}
		})
		s := newSession(t, b)
		r := newRecorder(t)
		s.Start(ctx, "d1", r.send)
		r.until("dictation:ready", "d1")

		// The first write never returns, so nothing leaves the queue.
		hold.Store(true)
		for i := range 3 {
			r.reply(s.Audio("d1", []byte{byte(i), 0, byte(i), 0}))
		}
		wantSent(t, r, ready("d1")) // 8 bytes queued before the third, not over 10
		r.reply(s.Audio("d1", []byte{9, 0, 9, 0}))
		wantError(t, r.until("dictation:error", "d1"), "d1", server.DictationOverloaded, "Speech service is not keeping up")
		wantIdle(t, s)
		if once.CompareAndSwap(false, true) {
			close(release)
		}
		f.session(t, 0).closed(t)
	})
}

// holdConn blocks writes while hold is set, until release closes.
type holdConn struct {
	net.Conn
	hold    *atomic.Bool
	release chan struct{}
}

func (c *holdConn) Write(p []byte) (int, error) {
	if c.hold.Load() {
		<-c.release
	}
	return c.Conn.Write(p)
}
