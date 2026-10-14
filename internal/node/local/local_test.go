package local

import (
	"context"
	"errors"
	"testing"

	"tmuxde/internal/config"
	"tmuxde/internal/node"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

type nopSink struct{}

func (nopSink) Send(context.Context, server.Message) error { return nil }

func TestNode(t *testing.T) {
	ctx := context.Background()
	n := NewWithDeps(config.Config{}, Deps{})
	const id node.ConnID = 7

	if err := n.Handle(ctx, id, &client.SessionList{Type: "session:list"}); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("Handle before Open = %v, want ErrNotOpen", err)
	}
	if err := n.Open(ctx, id, nil); err == nil {
		t.Fatal("Open with a nil sink succeeded")
	}
	if err := n.Open(ctx, id, nopSink{}); err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := n.Open(ctx, id, nopSink{}); !errors.Is(err, ErrAlreadyOpen) {
		t.Fatalf("second Open = %v, want ErrAlreadyOpen", err)
	}
	if got := n.OpenCount(); got != 1 {
		t.Fatalf("OpenCount = %d, want 1", got)
	}

	n.Close(id)
	n.Close(id)
	if got := n.OpenCount(); got != 0 {
		t.Fatalf("OpenCount after Close = %d, want 0", got)
	}
	if err := n.Handle(ctx, id, &client.SessionList{Type: "session:list"}); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("Handle after Close = %v, want ErrNotOpen", err)
	}
	if err := n.Open(ctx, id, nopSink{}); err != nil {
		t.Fatalf("Open after Close: %v", err)
	}
}

// TestOpenOutlivesItsContext checks that a connection lives until Close,
// not until the context Open was called with ends.
func TestOpenOutlivesItsContext(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	sink := newFakeSink(t)
	if err := h.n.Open(ctx, 1, sink); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := h.conn(1).ctx.Err(); err != nil {
		t.Fatalf("connection context ended with Open's: %v", err)
	}
	h.n.Close(1)
	if h.n.OpenCount() != 0 {
		t.Fatal("Close left the connection open")
	}
}

// TestNotWired covers a node without a tmux client. It answers like the
// stub did.
func TestNotWired(t *testing.T) {
	ctx := context.Background()
	n := NewWithDeps(config.Config{}, Deps{})
	if err := n.Open(ctx, 1, nopSink{}); err != nil {
		t.Fatal(err)
	}
	defer n.Close(1)
	if err := n.Start(ctx); err != nil {
		t.Fatalf("Start without tmux: %v", err)
	}
	n.Stop()

	tests := []struct {
		msg  client.Message
		want string
	}{
		{&client.SessionList{Type: "session:list"}, "not implemented: session:list"},
		{&client.SessionAttach{Type: "session:attach", Name: "work"}, "not implemented: session:attach"},
		{&client.TerminalInput{Type: "terminal:input", Data: "x"}, "not implemented: terminal:input"},
	}
	for _, tt := range tests {
		err := n.Handle(ctx, 1, tt.msg)
		if err == nil || err.Error() != tt.want {
			t.Errorf("Handle %s = %v, want %q", tt.msg.WireType(), err, tt.want)
		}
		if !errors.Is(err, ErrNotImplemented) || !errors.Is(err, ErrTmuxNotWired) {
			t.Errorf("Handle %s = %v, want ErrNotImplemented and ErrTmuxNotWired", tt.msg.WireType(), err)
		}
	}
	if err := n.Handle(ctx, 1, nil); err == nil || err.Error() != "not implemented: empty message" {
		t.Errorf("Handle nil = %v", err)
	}
}

// TestFilesNotWired covers a node built without the file and repository
// services. The file messages and repo:request answer with an error naming
// the type and touch nothing.
func TestFilesNotWired(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	h.setAttached(1, "work")
	msgs := []client.Message{
		&client.FileList{Type: "file:list", Path: "/x"},
		&client.FileRead{Type: "file:read", Path: "/x"},
		&client.FileStat{Type: "file:stat", Path: "/x"},
		&client.FileWatch{Type: "file:watch", Path: "/x"},
		&client.FileUnwatch{Type: "file:unwatch", Path: "/x"},
		&client.FileWrite{Type: "file:write", Path: "/x"},
		&client.FileCreate{Type: "file:create", Path: "/x"},
		&client.FileMkdir{Type: "file:mkdir", Path: "/x"},
		&client.FileDelete{Type: "file:delete", Path: "/x"},
		&client.FileRename{Type: "file:rename", OldPath: "/x", NewPath: "/y"},
		&client.FileUpload{Type: "file:upload", Path: "/x"},
		&client.RepoRequest{Type: "repo:request", RequestID: "r1", ID: "%1", Action: "context"},
	}
	for _, msg := range msgs {
		err := h.handle(1, msg)
		if !errors.Is(err, ErrNotImplemented) || !errors.Is(err, ErrFilesNotWired) || err.Error() != "not implemented: "+msg.WireType() {
			t.Errorf("Handle %s = %v", msg.WireType(), err)
		}
	}
	if got := sink.all(); len(got) != 0 {
		t.Fatalf("sink got %v", typesOf(got))
	}
	if got := h.tm.called("ListPanes"); len(got) != 0 {
		t.Fatalf("repo:request listed panes: %v", got)
	}
	if _, err := h.n.OpenFile(context.Background(), "/x"); !errors.Is(err, ErrFilesNotWired) {
		t.Fatalf("OpenFile = %v, want ErrFilesNotWired", err)
	}
}

// TestRefusesASecondAuthFrame ports "refuses a second auth frame instead of
// rubber-stamping it". The hub answers auth itself. Should one reach the
// node anyway, it is an error and nothing is sent, least of all
// auth:success.
func TestRefusesASecondAuthFrame(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	for _, msg := range []client.Message{
		&client.Auth{Type: "auth", Token: "anything at all"},
		&client.Ping{Type: "ping"},
		&client.DictationCancel{Type: "dictation:cancel", ID: "d1"},
	} {
		if err := h.handle(1, msg); !errors.Is(err, ErrNotForNode) {
			t.Errorf("Handle %s = %v, want ErrNotForNode", msg.WireType(), err)
		}
	}
	if got := sink.all(); len(got) != 0 {
		t.Fatalf("sink got %v", typesOf(got))
	}
}

// TestStart covers the startup sweep and the monitor wiring.
func TestStart(t *testing.T) {
	h := newHarness(t)
	h.tm.set(func(f *fakeTmux) { f.swept = 2 })
	a, b, c := h.open(1), h.open(2), h.open(3)
	h.attachReady(1, a, "work", nil)
	h.attachReady(2, b, "other", nil)
	h.attachReady(3, c, "work", nil)

	if err := h.n.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := h.n.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := len(h.tm.called("SweepOrphanClones")); got != 1 {
		t.Fatalf("sweep ran %d times, want 1", got)
	}
	h.mon.mu.Lock()
	started, hooks := h.mon.started, h.mon.hooks
	h.mon.mu.Unlock()
	if started != 1 {
		t.Fatalf("monitor started %d times, want 1", started)
	}
	if hooks.Watched == nil || hooks.OnSessionExit == nil || hooks.OnSessionCreated == nil ||
		hooks.OnSessionRenamed == nil || hooks.OnSessionsChanged == nil || hooks.OnWindowsChanged == nil {
		t.Fatal("monitor got a nil hook")
	}
	if got := hooks.Watched(); len(got) != 2 || got[0] != "other" || got[1] != "work" {
		t.Fatalf("Watched = %v, want [other work]", got)
	}
	h.must(2, &client.SessionDetach{Type: "session:detach"})
	if got := hooks.Watched(); len(got) != 1 || got[0] != "work" {
		t.Fatalf("Watched after detach = %v, want [work]", got)
	}

	h.n.Stop()
	h.mon.mu.Lock()
	stopped, mctx := h.mon.stopped, h.mon.ctx
	h.mon.mu.Unlock()
	if stopped != 1 {
		t.Fatalf("monitor stopped %d times, want 1", stopped)
	}
	if mctx.Err() == nil {
		t.Fatal("Stop left the monitor context running")
	}
}

// TestStartChecksTmux ports the relay's startup check: no tmux, no
// server. Nothing else runs, and a later Start tries again.
func TestStartChecksTmux(t *testing.T) {
	h := newHarness(t)
	h.tm.set(func(f *fakeTmux) { f.errs["Version"] = errBoom })
	err := h.n.Start(context.Background())
	if !errors.Is(err, ErrNoTmux) || !errors.Is(err, errBoom) {
		t.Fatalf("Start = %v, want ErrNoTmux wrapping errBoom", err)
	}
	if got := h.tm.called("SweepOrphanClones"); len(got) != 0 {
		t.Fatalf("sweep ran without tmux: %v", got)
	}
	h.mon.mu.Lock()
	started := h.mon.started
	h.mon.mu.Unlock()
	if started != 0 {
		t.Fatal("monitor started without tmux")
	}

	h.tm.set(func(f *fakeTmux) { delete(f.errs, "Version") })
	if err := h.n.Start(context.Background()); err != nil {
		t.Fatalf("Start once tmux runs: %v", err)
	}
	if got := len(h.tm.called("SweepOrphanClones")); got != 1 {
		t.Fatalf("sweep ran %d times, want 1", got)
	}
}

func TestStartMonitorError(t *testing.T) {
	h := newHarness(t)
	h.mon.startErr = errBoom
	if err := h.n.Start(context.Background()); !errors.Is(err, errBoom) {
		t.Fatalf("Start = %v, want errBoom", err)
	}
}
