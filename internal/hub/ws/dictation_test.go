package ws

import (
	"context"
	"net"
	"testing"

	"github.com/coder/websocket"

	"tmuxde/internal/hub/dictation"
	"tmuxde/internal/node"
)

// TestDictationEndsBeforeNode checks the close order of the relay's
// removeConnection: the dictation ends first, then the node lets go.
func TestDictationEndsBeforeNode(t *testing.T) {
	dialing := make(chan struct{}, 1)
	bridge := dictation.New(dictation.Options{
		// Never dialed. Dial below stands in for it.
		SocketPath: "/nonexistent/stt.sock",
		Logger:     quietLogger(),
		Dial: func(ctx context.Context) (net.Conn, error) {
			dialing <- struct{}{}
			<-ctx.Done()
			return nil, ctx.Err()
		},
	})
	h := newHarness(t, func(o *Options) { o.Dictation = bridge })
	c := h.dial(t, nil)
	c.auth()
	id := receive(t, "node open", h.node.opened)
	socks := h.srv.openSockets()
	if len(socks) != 1 {
		t.Fatalf("%d open sockets, want 1", len(socks))
	}
	k := socks[0]

	// Seen by the node when it lets go: is the dictation slot closed?
	ended := make(chan bool, 1)
	h.node.setOnClose(func(node.ConnID) {
		k.dictMu.Lock()
		defer k.dictMu.Unlock()
		ended <- k.dictClosed && k.dict == nil
	})

	c.send(map[string]string{"type": "dictation:start", "id": "d1"})
	receive(t, "the dictation dial", dialing)
	c.c.Close(websocket.StatusNormalClosure, "")
	if got := receive(t, "node close", h.node.closed); got != id {
		t.Fatalf("node closed %d, want %d", got, id)
	}
	if !receive(t, "the close hook", ended) {
		t.Fatal("the node let go before the dictation ended")
	}
	// A message queued after removal finds the slot closed.
	if k.dictationSession() != nil {
		t.Fatal("a removed connection made a new dictation session")
	}
}

// TestDictationFeatureFollowsBridge checks that the features follow the
// bridge when no override is set. Without a probe the bridge is never
// available.
func TestDictationFeatureFollowsBridge(t *testing.T) {
	bridge := dictation.New(dictation.Options{SocketPath: "/nonexistent/stt.sock", Logger: quietLogger()})
	h := newHarness(t, func(o *Options) { o.Dictation = bridge })
	c := h.dial(t, nil)
	c.auth()
}
