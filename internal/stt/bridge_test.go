package stt

import (
	"context"
	"io"
	"log/slog"
	"reflect"
	"sync"
	"testing"
	"time"

	"tmuxde/internal/hub/dictation"
	"tmuxde/internal/protocol/server"
)

// browser collects what the hub bridge would send to one browser.
type browser struct {
	mu   sync.Mutex
	msgs []server.Message
	got  chan struct{}
}

func newBrowser() *browser { return &browser{got: make(chan struct{}, 64)} }

func (b *browser) send(m server.Message) error {
	b.mu.Lock()
	b.msgs = append(b.msgs, m)
	b.mu.Unlock()
	b.got <- struct{}{}
	return nil
}

// waitFor waits until a message of type typ arrived and returns all so
// far.
func (b *browser) waitFor(t *testing.T, typ string) []server.Message {
	t.Helper()
	deadline := time.After(waitLimit)
	for {
		b.mu.Lock()
		msgs := append([]server.Message(nil), b.msgs...)
		b.mu.Unlock()
		for _, m := range msgs {
			if m.WireType() == typ {
				return msgs
			}
		}
		select {
		case <-b.got:
		case <-deadline:
			t.Fatalf("no %s, got %v", typ, msgs)
		}
	}
}

func newBridge(t *testing.T, path string) *dictation.Bridge {
	t.Helper()
	return dictation.New(dictation.Options{
		SocketPath: path,
		ProbeUp:    20 * time.Millisecond,
		ProbeDown:  20 * time.Millisecond,
		Logger:     slog.New(slog.NewJSONHandler(io.Discard, nil)),
	})
}

// The hub bridge is the only client of this service. These tests run it
// against the real server, so the wire contract cannot drift.
func TestBridgeDictatesThroughTheService(t *testing.T) {
	path := start(t, &counting{}, startOptions{})
	b := newBridge(t, path)

	ctx, cancel := context.WithCancel(context.Background())
	probeDone := b.StartProbe(ctx)
	defer func() {
		cancel()
		<-probeDone
	}()
	deadline := time.Now().Add(waitLimit)
	for !b.Available() {
		if time.Now().After(deadline) {
			t.Fatal("the probe never saw the service")
		}
		time.Sleep(5 * time.Millisecond)
	}

	sess := b.NewSession()
	defer sess.Close()
	br := newBrowser()
	sess.Start(context.Background(), "d1", br.send)
	br.waitFor(t, "dictation:ready")
	if reply := sess.Audio("d1", silence(1)); reply != nil {
		t.Fatalf("audio reply %v", reply)
	}
	if reply := sess.Stop("d1"); reply != nil {
		t.Fatalf("stop reply %v", reply)
	}
	got := br.waitFor(t, "dictation:done")
	want := []server.Message{
		&server.DictationReady{Type: "dictation:ready", ID: "d1"},
		&server.DictationText{Type: "dictation:text", ID: "d1", Text: "samples 16000"},
		&server.DictationDone{Type: "dictation:done", ID: "d1"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("browser got %v, want %v", got, want)
	}
}

func TestBridgeReportsBusy(t *testing.T) {
	path := start(t, &counting{}, startOptions{maxSessions: 1})
	first := openSession(t, path)
	first.waitReady(t)

	b := newBridge(t, path)
	sess := b.NewSession()
	defer sess.Close()
	br := newBrowser()
	sess.Start(context.Background(), "d2", br.send)
	got := br.waitFor(t, "dictation:error")
	e, ok := got[len(got)-1].(*server.DictationError)
	if !ok || e.Code != server.DictationBusy {
		t.Fatalf("browser got %v, want BUSY", got)
	}
}

func TestBridgeReportsAServiceError(t *testing.T) {
	path := start(t, &counting{}, startOptions{})
	b := newBridge(t, path)
	sess := b.NewSession()
	defer sess.Close()
	br := newBrowser()
	sess.Start(context.Background(), "d3", br.send)
	br.waitFor(t, "dictation:ready")
	sess.Audio("d3", make([]byte, 3))
	got := br.waitFor(t, "dictation:error")
	e, ok := got[len(got)-1].(*server.DictationError)
	if !ok || e.Code != server.DictationFailed || e.Message != "Audio must be 16-bit PCM" {
		t.Fatalf("browser got %v", got)
	}
}
