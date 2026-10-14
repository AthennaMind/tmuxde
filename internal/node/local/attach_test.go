package local

import (
	"errors"
	"fmt"
	"os"
	"slices"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"

	"tmuxde/internal/node/pty"
	"tmuxde/internal/node/tmux"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

func attachMsg(name string, capture bool) *client.SessionAttach {
	return &client.SessionAttach{Type: "session:attach", Name: name, Capture: ptr(capture)}
}

// Ported from message-router.test.ts, describe "session:attach".
func TestSessionAttach(t *testing.T) {
	t.Run("acks before replaying the capture", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		h.must(1, attachMsg("work", true))
		h.lastBridge().fireReady()

		msgs := sink.waitCount(2)
		if got := typesOf(msgs); !slices.Equal(got, []string{"session:attached", "terminal:output"}) {
			t.Fatalf("got %v, want ack then replay", got)
		}
		// The browser drops output until it has seen the ack, so this order
		// is the difference between a painted screen and a blank one.
		if out := msgs[1].(*server.TerminalOutput); out.Data != "REPLAYED SCROLLBACK" {
			t.Fatalf("replay = %q", out.Data)
		}
		if got := h.tm.captureOpts; len(got) != 1 || got[0] != (tmux.CaptureOptions{Lines: 2000, Escapes: true}) {
			t.Fatalf("capture options = %+v, want 2000 lines with escapes", got)
		}
	})

	t.Run("ends replayed lines with CRLF so they do not draw as a staircase", func(t *testing.T) {
		h := newHarness(t)
		h.tm.set(func(f *fakeTmux) { f.capture = "\x1b[1mone\x1b[0m\ntwo\r\n\nthree\n" })
		sink := h.open(1)
		h.must(1, attachMsg("work", true))
		h.lastBridge().fireReady()

		msgs := sink.waitCount(2)
		// capture-pane ends lines with a bare LF. Written raw, each line
		// started at the column where the previous one ended.
		want := "\x1b[1mone\x1b[0m\r\ntwo\r\n\r\nthree\r\n"
		if out := msgs[1].(*server.TerminalOutput); out.Data != want {
			t.Fatalf("replay = %q, want %q", out.Data, want)
		}
	})

	t.Run("echoes the attachId so the client can reject stale acks", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		msg := attachMsg("work", true)
		msg.AttachID = ptr("a7")
		h.must(1, msg)
		h.lastBridge().fireReady()

		ack := sink.waitCount(1)[0].(*server.SessionAttached)
		if ack.Name != "work" || ack.AttachID == nil || *ack.AttachID != "a7" {
			t.Fatalf("ack = %+v, want work with a7", ack)
		}
	})

	t.Run("omits an empty attachId", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		msg := attachMsg("work", false)
		msg.AttachID = ptr("")
		h.must(1, msg)
		h.lastBridge().fireReady()

		if ack := sink.waitCount(1)[0].(*server.SessionAttached); ack.AttachID != nil {
			t.Fatalf("ack carries attachId %q", *ack.AttachID)
		}
	})

	t.Run("still attaches when the capture fails", func(t *testing.T) {
		h := newHarness(t)
		h.tm.set(func(f *fakeTmux) { f.captureErr = errors.New("stdout maxBuffer length exceeded") })
		sink := h.open(1)
		h.must(1, attachMsg("huge", true))
		b := h.lastBridge()
		b.fireReady()
		sink.waitCount(1)

		// The old pty is already dead when the capture runs. Aborting here
		// left large sessions with a blank terminal for good.
		st := h.state(1)
		if st.bridge != b || st.attached != "huge" {
			t.Fatalf("state = %+v, want attached to huge", st)
		}
		if got := sink.types(); !slices.Equal(got, []string{"session:attached"}) {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("leaves no stale attachedSession when the session is gone", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		old := h.attachReady(1, sink, "old", nil)
		if h.state(1).attached != "old" {
			t.Fatal("not attached to old")
		}

		sink.reset()
		h.tm.set(func(f *fakeTmux) { f.missing["gone"] = true })
		h.must(1, attachMsg("gone", false))

		st := h.state(1)
		if st.bridge != nil || st.attached != "" || st.pumping {
			t.Fatalf("state = %+v, want nothing attached", st)
		}
		msgs := sink.all()
		if len(msgs) != 1 {
			t.Fatalf("got %v, want one error", typesOf(msgs))
		}
		wantError(t, msgs[0], CodeSessionNotFound, `Session "gone" not found`)
		if _, _, ev := old.snapshot(); !slices.Equal(ev, []string{"MarkDetaching", "Close"}) {
			t.Fatalf("old bridge events = %v, want MarkDetaching then Close", ev)
		}
	})

	t.Run("leaves no stale attachedSession when the PTY fails to spawn", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		h.attachReady(1, sink, "old", nil)

		sink.reset()
		h.failSpawn(errors.New("no pty"))
		h.must(1, attachMsg("broken", false))

		st := h.state(1)
		if st.bridge != nil || st.attached != "" {
			t.Fatalf("state = %+v, want nothing attached", st)
		}
		wantError(t, sink.last(), CodePtySpawnFailed, "no pty")
	})
}

// TestAttachOptions checks what the attacher gets: the real name, the
// size of the message, the configured socket and -N when tmux takes it.
func TestAttachOptions(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	h.tm.set(func(f *fakeTmux) { f.noStart = true })
	h.attachReady(1, sink, "work", &protocol.TerminalSize{Cols: 120, Rows: 40})
	h.tm.set(func(f *fakeTmux) { f.noStart = false })
	h.attachReady(1, sink, "other", nil)

	h.mu.Lock()
	calls := slices.Clone(h.attaches)
	h.mu.Unlock()
	if len(calls) != 2 {
		t.Fatalf("attacher ran %d times", len(calls))
	}
	if c := calls[0]; c.session != "work" || c.opts.Cols != 120 || c.opts.Rows != 40 || c.opts.Socket != "/run/test/tmux.sock" || !c.opts.NoStart {
		t.Fatalf("first attach = %+v", c)
	}
	if c := calls[1]; c.session != "other" || c.opts.Cols != 0 || c.opts.Rows != 0 || c.opts.NoStart {
		t.Fatalf("second attach = %+v, want default size and no -N", c)
	}
	if st := h.state(1); st.lastSize != nil {
		t.Fatalf("lastSize = %+v after an attach without size", st.lastSize)
	}
}

// TestSessionDetach ports describe "session:detach".
func TestSessionDetach(t *testing.T) {
	t.Run("clears attachedSession even with no live PTY", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		h.setAttached(1, "orphan")

		h.must(1, &client.SessionDetach{Type: "session:detach"})

		st := h.state(1)
		if st.attached != "" || st.lastSize != nil {
			t.Fatalf("state = %+v, want cleared", st)
		}
		if got := sink.all(); len(got) != 0 {
			t.Fatalf("detach sent %v", typesOf(got))
		}
	})

	t.Run("releases the pty and says nothing", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		b := h.attachReady(1, sink, "work", &protocol.TerminalSize{Cols: 80, Rows: 24})
		sink.reset()

		h.must(1, &client.SessionDetach{Type: "session:detach"})

		st := h.state(1)
		if st.bridge != nil || st.attached != "" || st.lastSize != nil || st.pumping {
			t.Fatalf("state = %+v, want cleared", st)
		}
		if _, _, ev := b.snapshot(); !slices.Equal(ev, []string{"MarkDetaching", "Close"}) {
			t.Fatalf("bridge events = %v", ev)
		}
		if got := sink.all(); len(got) != 0 {
			t.Fatalf("detach sent %v", typesOf(got))
		}
	})
}

// TestTerminalResize ports describe "terminal:resize".
func TestTerminalResize(t *testing.T) {
	resize := func(cols, rows int) *client.TerminalResize {
		return &client.TerminalResize{Type: "terminal:resize", Size: protocol.TerminalSize{Cols: cols, Rows: rows}}
	}

	t.Run("applies a changed size once and drops the repeats", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		b := h.attachReady(1, sink, "work", &protocol.TerminalSize{Cols: 80, Rows: 24})

		for range 3 {
			h.must(1, resize(100, 40))
		}
		// Every resize is a SIGWINCH that makes tmux redraw every attached
		// client, so the same size must not reach the pty twice.
		if _, got, _ := b.snapshot(); !slices.Equal(got, []protocol.TerminalSize{{Cols: 100, Rows: 40}}) {
			t.Fatalf("resizes = %v", got)
		}
		h.must(1, resize(120, 40))
		if _, got, _ := b.snapshot(); len(got) != 2 {
			t.Fatalf("resizes = %v, want 2", got)
		}
	})

	t.Run("drops a resize that matches the size sent with the attach", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		b := h.attachReady(1, sink, "work", &protocol.TerminalSize{Cols: 80, Rows: 24})

		h.must(1, resize(80, 24))

		if _, got, _ := b.snapshot(); len(got) != 0 {
			t.Fatalf("resizes = %v, want none", got)
		}
	})

	t.Run("applies the first resize after an attach without size", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		b := h.attachReady(1, sink, "work", nil)

		h.must(1, resize(80, 24))

		if _, got, _ := b.snapshot(); len(got) != 1 {
			t.Fatalf("resizes = %v, want one", got)
		}
	})

	t.Run("refuses a resize with nothing attached", func(t *testing.T) {
		h := newHarness(t)
		sink := h.open(1)
		h.setAttached(1, "work")

		h.must(1, resize(80, 24))

		wantError(t, sink.last(), CodeNotAttached, "No session attached")
	})
}

// TestStaleReadyIsDropped checks the Go guard the relay lacked: a ready
// that fires for an attach that was already replaced sends no ack.
func TestStaleReadyIsDropped(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)

	first := h.next(newFakeBridge("first", 8))
	// tmux writes at the moment the old client is killed, so ready fires
	// while the teardown runs.
	first.readyOnClose = true
	first.stuck = true
	msg := attachMsg("first", false)
	msg.AttachID = ptr("a1")
	h.must(1, msg)

	msg = attachMsg("second", false)
	msg.AttachID = ptr("a2")
	h.must(1, msg)
	select {
	case <-first.Ready():
	default:
		t.Fatal("the old bridge never fired ready")
	}
	h.lastBridge().fireReady()

	msgs := sink.waitCount(1)
	if len(msgs) != 1 {
		t.Fatalf("got %v, want one ack", typesOf(msgs))
	}
	ack := msgs[0].(*server.SessionAttached)
	if ack.Name != "second" || *ack.AttachID != "a2" {
		t.Fatalf("ack = %s %s, want second a2", ack.Name, *ack.AttachID)
	}
	// The old bridge exits late. Its end must not touch the new state.
	first.end(pty.Result{ExitCode: 1})
	if st := h.state(1); st.attached != "second" {
		t.Fatalf("attached = %q, want second", st.attached)
	}
	if got := sink.types(); !slices.Equal(got, []string{"session:attached"}) {
		t.Fatalf("got %v", got)
	}
}

// TestOutputAfterDetachIsDropped holds the pump in a send, detaches, and
// checks that only the chunk already on its way arrives. Detach waits for
// the pump, so nothing of the old pty can follow it.
func TestOutputAfterDetachIsDropped(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	b := h.next(newFakeBridge("work", 8))
	b.stuck = true
	h.attachReady(1, sink, "work", nil)
	sink.reset()

	gate := make(chan struct{})
	inSend := make(chan struct{})
	var once sync.Once
	sink.setGate(func(m server.Message) <-chan struct{} {
		if m.WireType() == "terminal:output" {
			once.Do(func() { close(inSend) })
			return gate
		}
		return nil
	})
	b.emit("one")
	b.emit("two")
	// The pump holds "one" in a send, "two" waits in the queue.
	<-inSend

	detached := make(chan error, 1)
	go func() { detached <- h.handle(1, &client.SessionDetach{Type: "session:detach"}) }()
	waitUntil(t, "detach to mark the bridge", func() bool {
		_, _, ev := b.snapshot()
		return slices.Contains(ev, "Close")
	})
	close(gate)
	if err := <-detached; err != nil {
		t.Fatal(err)
	}
	if st := h.state(1); st.pumping {
		t.Fatal("pump still runs after detach returned")
	}
	b.emit("three")

	var got []string
	for _, m := range sink.all() {
		got = append(got, m.(*server.TerminalOutput).Data)
	}
	if !slices.Equal(got, []string{"one"}) {
		t.Fatalf("output = %q, want only the chunk in flight", got)
	}
}

// TestPtyExit covers onExit: session:exited with the code, then state
// cleared, so the next attach starts clean.
func TestPtyExit(t *testing.T) {
	for _, code := range []int{0, 3} {
		t.Run(fmt.Sprint("code ", code), func(t *testing.T) {
			h := newHarness(t)
			sink := h.open(1)
			b := h.attachReady(1, sink, "work", &protocol.TerminalSize{Cols: 80, Rows: 24})
			b.emit("bye")
			b.end(pty.Result{ExitCode: code})

			msgs := sink.waitFor(func(m []server.Message) bool {
				return len(m) > 0 && m[len(m)-1].WireType() == "session:exited"
			})
			if got := typesOf(msgs); !slices.Equal(got, []string{"session:attached", "terminal:output", "session:exited"}) {
				t.Fatalf("got %v", got)
			}
			ex := msgs[2].(*server.SessionExited)
			if ex.Name != "work" || ex.ExitCode == nil || *ex.ExitCode != float64(code) {
				t.Fatalf("exited = %+v", ex)
			}
			st := h.state(1)
			if st.bridge != nil || st.attached != "" || st.lastSize != nil {
				t.Fatalf("state = %+v, want cleared", st)
			}
			h.attachReady(1, sink, "other", nil)
			if st := h.state(1); st.attached != "other" {
				t.Fatalf("re-attach state = %+v", st)
			}
		})
	}
}

// TestPtySpawnErrorBeforeReady covers onSpawnError: a pty that ends before
// ready is a failed spawn, not an attach followed by an exit.
func TestPtySpawnErrorBeforeReady(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	h.must(1, attachMsg("work", true))
	b := h.lastBridge()
	b.end(pty.Result{ExitCode: 1, SpawnErr: errors.New("tmux attach-session exited with code 1 before ready: can't find session: work")})

	msgs := sink.waitCount(1)
	if len(msgs) != 1 {
		t.Fatalf("got %v", typesOf(msgs))
	}
	wantError(t, msgs[0], CodePtySpawnFailed, "tmux attach-session exited with code 1 before ready: can't find session: work")
	if st := h.state(1); st.attached != "" || st.bridge != nil {
		t.Fatalf("state = %+v, want cleared", st)
	}
}

// TestCloseReleasesThePty covers Close: the pty is marked detaching and
// closed, the pump stops and nothing more is sent.
func TestCloseReleasesThePty(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	b := h.attachReady(1, sink, "work", nil)
	b.emit("before")
	sink.waitCount(2)
	c := h.conn(1)

	h.n.Close(1)

	if _, _, ev := b.snapshot(); len(ev) < 2 || ev[0] != "MarkDetaching" || !slices.Contains(ev, "Close") {
		t.Fatalf("bridge events = %v, want MarkDetaching first and Close", ev)
	}
	select {
	case <-c.ctx.Done():
	default:
		t.Fatal("Close left the connection context running")
	}
	c.mu.Lock()
	att, last := c.att, c.last
	c.mu.Unlock()
	if att != nil || last != nil {
		t.Fatal("Close left an attachment")
	}
	if h.n.OpenCount() != 0 {
		t.Fatal("Close left the connection open")
	}
	if b.emit("after") {
		t.Fatal("bridge still takes output after Close")
	}
	if got := sink.types(); !slices.Equal(got, []string{"session:attached", "terminal:output"}) {
		t.Fatalf("got %v", got)
	}
}

// TestCloseStopsAPumpStuckOnTheSink: a browser that stopped reading must
// not keep Close waiting.
func TestCloseStopsAPumpStuckOnTheSink(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	b := h.attachReady(1, sink, "work", nil)
	inSend := make(chan struct{})
	var once sync.Once
	sink.setGate(func(server.Message) <-chan struct{} {
		once.Do(func() { close(inSend) })
		return make(chan struct{})
	})
	b.emit("stuck")
	<-inSend

	h.n.Close(1)

	if h.n.OpenCount() != 0 {
		t.Fatal("Close left the connection open")
	}
}

// TestCloseDuringAttach: a connection that closes while its attach runs
// must not keep the new pty.
func TestCloseDuringAttach(t *testing.T) {
	h := newHarness(t)
	h.open(1)
	c := h.conn(1)
	b := newFakeBridge("work", 8)

	h.n.Close(1)
	if _, ok := c.install("work", b, nil); ok {
		t.Fatal("install took a bridge on a closed connection")
	}
}

// TestSlowSinkBlocksThePump: a sink that does not take output stops the
// pump, the pump stops draining the bridge, and the producer blocks. When
// the sink moves again, every chunk arrives once and in order.
func TestSlowSinkBlocksThePump(t *testing.T) {
	const queue, total = 2, 200
	h := newHarness(t)
	sink := h.open(1)
	b := h.next(newFakeBridge("work", queue))
	h.attachReady(1, sink, "work", nil)
	sink.reset()

	gate := make(chan struct{})
	sink.setGate(func(m server.Message) <-chan struct{} {
		if m.WireType() == "terminal:output" {
			return gate
		}
		return nil
	})

	var emitted atomic.Int64
	produced := make(chan struct{})
	go func() {
		defer close(produced)
		for i := range total {
			if !b.emit(fmt.Sprint(i)) {
				return
			}
			emitted.Add(1)
		}
	}()

	// One chunk in the pump, a full queue, the producer parked on the next.
	waitUntil(t, "the queue to fill", func() bool { return emitted.Load() == queue+1 })
	select {
	case <-produced:
		t.Fatal("producer finished while the sink was stuck")
	default:
	}
	if got := len(sink.all()); got != 0 {
		t.Fatalf("sink took %d chunks through a closed gate", got)
	}

	close(gate)
	<-produced
	msgs := sink.waitCount(total)
	for i, m := range msgs {
		if got := m.(*server.TerminalOutput).Data; got != fmt.Sprint(i) {
			t.Fatalf("chunk %d = %q, output lost or reordered", i, got)
		}
	}
}

// TestCommands covers the command and input table of spec section 1.
func TestCommands(t *testing.T) {
	tests := []struct {
		name string
		msg  client.Message
		// write is what reaches the pty when attached, "" for none.
		write string
		// refused is true when nothing attached answers NOT_ATTACHED.
		refused bool
	}{
		{"terminal:input", &client.TerminalInput{Type: "terminal:input", Data: "ls -la"}, "ls -la", true},
		{"command:send", &client.CommandSend{Type: "command:send", Command: "make"}, "make\r", true},
		{"command:eof", &client.CommandEOF{Type: "command:eof"}, "\x04", false},
		{"command:clear", &client.CommandClear{Type: "command:clear"}, "\x1b[2J\x1b[H", false},
		{"command:suspend", &client.CommandSuspend{Type: "command:suspend"}, "\x1a", false},
		{"command:interrupt", &client.CommandInterrupt{Type: "command:interrupt"}, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name+" unattached", func(t *testing.T) {
			h := newHarness(t)
			sink := h.open(1)
			h.must(1, tt.msg)
			if tt.refused {
				wantError(t, sink.last(), CodeNotAttached, "No session attached")
			} else if got := sink.all(); len(got) != 0 {
				t.Fatalf("got %v, want a silent no-op", typesOf(got))
			}
			if got := h.tm.called("SendInterrupt"); len(got) != 0 {
				t.Fatalf("interrupt sent with nothing attached: %v", got)
			}
		})
		t.Run(tt.name+" attached", func(t *testing.T) {
			h := newHarness(t)
			sink := h.open(1)
			b := h.attachReady(1, sink, "work", nil)
			sink.reset()
			h.must(1, tt.msg)
			writes, _, _ := b.snapshot()
			if tt.write == "" {
				if len(writes) != 0 {
					t.Fatalf("writes = %q, want none", writes)
				}
				if got := h.tm.called("SendInterrupt"); !slices.Equal(got, []string{"SendInterrupt work"}) {
					t.Fatalf("interrupt calls = %v", got)
				}
			} else if !slices.Equal(writes, []string{tt.write}) {
				t.Fatalf("writes = %q, want %q", writes, tt.write)
			}
			if got := sink.all(); len(got) != 0 {
				t.Fatalf("got %v, want no reply", typesOf(got))
			}
		})
	}
}

// TestWriteBlocksUntilClose: a pty write blocks while tmux does not read,
// with no buffer in between, and Close ends it.
func TestWriteBlocksUntilClose(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	b := h.next(newFakeBridge("work", 8))
	b.blockWrites = true
	h.attachReady(1, sink, "work", nil)

	done := make(chan error, 1)
	go func() { done <- h.handle(1, &client.TerminalInput{Type: "terminal:input", Data: "x"}) }()
	<-b.writing
	select {
	case err := <-done:
		t.Fatalf("write returned before Close: %v", err)
	default:
	}

	h.n.Close(1)
	if err := <-done; !errors.Is(err, os.ErrClosed) {
		t.Fatalf("write ended with %v, want os.ErrClosed", err)
	}
}

// TestPtyGoneUnderAWrite: a keystroke that races the end of the pty is
// dropped quietly, as node-pty did. The pump reports the end. Any other
// pty error is a handler error.
func TestPtyGoneUnderAWrite(t *testing.T) {
	tests := []struct {
		err  error
		want string
	}{
		{os.ErrClosed, ""},
		{fmt.Errorf("write /dev/ptmx: %w", syscall.EIO), ""},
		{errBoom, "boom"},
	}
	for _, tt := range tests {
		t.Run(tt.err.Error(), func(t *testing.T) {
			h := newHarness(t)
			sink := h.open(1)
			b := h.next(newFakeBridge("work", 8))
			b.failWith = tt.err
			h.attachReady(1, sink, "work", nil)
			sink.reset()

			for _, msg := range []client.Message{
				&client.TerminalInput{Type: "terminal:input", Data: "x"},
				&client.TerminalResize{Type: "terminal:resize", Size: protocol.TerminalSize{Cols: 90, Rows: 30}},
			} {
				err := h.handle(1, msg)
				if tt.want == "" && err != nil {
					t.Fatalf("Handle %s = %v, want nil", msg.WireType(), err)
				}
				if tt.want != "" && (err == nil || !errors.Is(err, tt.err)) {
					t.Fatalf("Handle %s = %v, want %v", msg.WireType(), err, tt.err)
				}
			}
			if got := sink.all(); len(got) != 0 {
				t.Fatalf("got %v", typesOf(got))
			}
		})
	}
}
