package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/hub/accesslog"
	"tmuxde/internal/node"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

const (
	testToken     = "test-token-0123456789"
	allowedOrigin = "http://tmuxde.test"
	// waitLimit bounds every wait in these tests. Nothing should come
	// close to it.
	waitLimit = 5 * time.Second
)

// welcome is what a successful auth gets, byte for byte, from a harness
// with the default options.
var (
	wantAuthSuccess = `{"type":"auth:success","serverVersion":"1.0.0",` +
		`"capabilities":{"readOnly":false,"files":"write","scope":"all"},` +
		`"features":["repo:request","repo:history","file:upload:ack","file:upload:1gib","window:step","pane:step","repo:watch","repo:graph","terminal:search","terminal:preview","repo:search"]}`
	wantServerInfo = `{"type":"server:info","hostname":"testhost","platform":"` + runtime.GOOS +
		`","uptime":1234.5,"defaultPath":"/srv/work"}`
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// clock is a settable clock.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *clock {
	return &clock{now: time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)}
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// fakeNode records the node calls. session:list fails, session:kill
// answers through the sink, so tests can see both paths.
type fakeNode struct {
	openErr error

	mu sync.Mutex
	// onClose runs in Close before it reports on closed.
	onClose func(node.ConnID)
	sinks   map[node.ConnID]node.Sink
	opened  chan node.ConnID
	closed  chan node.ConnID
	handled []string
}

func newFakeNode() *fakeNode {
	return &fakeNode{
		sinks:  map[node.ConnID]node.Sink{},
		opened: make(chan node.ConnID, 64),
		closed: make(chan node.ConnID, 64),
	}
}

func (n *fakeNode) Open(_ context.Context, id node.ConnID, out node.Sink) error {
	if n.openErr != nil {
		return n.openErr
	}
	n.mu.Lock()
	n.sinks[id] = out
	n.mu.Unlock()
	n.opened <- id
	return nil
}

func (n *fakeNode) Handle(ctx context.Context, id node.ConnID, msg client.Message) error {
	n.mu.Lock()
	out := n.sinks[id]
	n.handled = append(n.handled, msg.WireType())
	n.mu.Unlock()
	if out == nil {
		return fmt.Errorf("connection %d not open", id)
	}
	switch m := msg.(type) {
	case *client.SessionList:
		return errors.New("tmux is not running")
	case *client.SessionKill:
		return out.Send(ctx, &server.SessionKilled{Type: "session:killed", Name: m.Name})
	}
	return fmt.Errorf("unexpected %s", msg.WireType())
}

func (n *fakeNode) Close(id node.ConnID) {
	n.mu.Lock()
	delete(n.sinks, id)
	onClose := n.onClose
	n.mu.Unlock()
	if onClose != nil {
		onClose(id)
	}
	n.closed <- id
}

func (n *fakeNode) setOnClose(fn func(node.ConnID)) {
	n.mu.Lock()
	n.onClose = fn
	n.mu.Unlock()
}

func (n *fakeNode) handledTypes() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.handled...)
}

// linkedNode is a node on another machine, like the remote node of
// package machine. Done of a connection closes when its link to the
// machine ends, and Close ends the link. Nothing else ends it unless a
// test calls end.
type linkedNode struct {
	*fakeNode

	linkMu sync.Mutex
	links  map[node.ConnID]*nodeLink
}

type nodeLink struct {
	done chan struct{}
	once sync.Once
}

func newLinkedNode() *linkedNode {
	return &linkedNode{fakeNode: newFakeNode(), links: map[node.ConnID]*nodeLink{}}
}

func (n *linkedNode) Open(ctx context.Context, id node.ConnID, out node.Sink) error {
	n.linkMu.Lock()
	n.links[id] = &nodeLink{done: make(chan struct{})}
	n.linkMu.Unlock()
	return n.fakeNode.Open(ctx, id, out)
}

func (n *linkedNode) Close(id node.ConnID) {
	n.end(id)
	n.fakeNode.Close(id)
}

// Done returns a closed channel for a connection that was never opened,
// as the remote node does.
func (n *linkedNode) Done(id node.ConnID) <-chan struct{} {
	n.linkMu.Lock()
	defer n.linkMu.Unlock()
	if l := n.links[id]; l != nil {
		return l.done
	}
	done := make(chan struct{})
	close(done)
	return done
}

// end ends the machine link of a connection, as a lost agent does.
func (n *linkedNode) end(id node.ConnID) {
	n.linkMu.Lock()
	l := n.links[id]
	n.linkMu.Unlock()
	if l != nil {
		l.once.Do(func() { close(l.done) })
	}
}

// remoteHarness is a harness whose sockets all resolve to one linkedNode.
func remoteHarness(t *testing.T) (*harness, *linkedNode) {
	t.Helper()
	n := newLinkedNode()
	h := newHarness(t, func(o *Options) {
		o.Node = nil
		o.Resolve = func(string) (Target, error) {
			return Target{
				Node:     n,
				Info:     server.ServerInfo{Type: "server:info", Hostname: "agent", Platform: "linux"},
				Features: []string{},
			}, nil
		}
	})
	return h, n
}

// authRemote authenticates against a remoteHarness and reads the two
// welcome messages.
func (c *wsClient) authRemote() {
	c.t.Helper()
	c.authWith(testToken)
	c.expect(`{"type":"auth:success","serverVersion":"1.0.0",` +
		`"capabilities":{"readOnly":false,"files":"write","scope":"all"},"features":[]}`)
	c.expect(`{"type":"server:info","hostname":"agent","platform":"linux","uptime":1234.5}`)
}

// harness is a Server behind httptest on loopback.
type harness struct {
	srv    *Server
	node   *fakeNode
	url    string
	logDir string
}

func newHarness(t *testing.T, mutate func(*Options)) *harness {
	t.Helper()
	n := newFakeNode()
	dir := t.TempDir()
	opts := Options{
		Token:       testToken,
		Origins:     []string{allowedOrigin},
		DefaultPath: "/srv/work",
		Node:        n,
		AccessLog:   accesslog.New(dir, quietLogger()),
		Logger:      quietLogger(),
		Hostname:    func() string { return "testhost" },
		Uptime:      func() float64 { return 1234.5 },
	}
	if mutate != nil {
		mutate(&opts)
	}
	srv, err := New(opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle(Path, srv)
	hs := httptest.NewServer(mux)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
		hs.Close()
	})
	return &harness{
		srv:    srv,
		node:   n,
		url:    "ws" + strings.TrimPrefix(hs.URL, "http") + Path,
		logDir: dir,
	}
}

// wsClient is a browser stand in.
type wsClient struct {
	t *testing.T
	c *websocket.Conn
}

func (h *harness) dial(t *testing.T, header http.Header) *wsClient {
	t.Helper()
	return dialURL(t, h.url, &websocket.DialOptions{HTTPHeader: header})
}

func dialURL(t *testing.T, url string, opts *websocket.DialOptions) *wsClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, opts)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return &wsClient{t: t, c: c}
}

// dialStatus dials and expects the handshake to fail with status.
func (h *harness) dialStatus(t *testing.T, header http.Header, status int, body string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, h.url, &websocket.DialOptions{HTTPHeader: header})
	if err == nil {
		c.CloseNow()
		t.Fatalf("dial succeeded, want HTTP %d", status)
	}
	if resp == nil {
		t.Fatalf("dial: %v, no response", err)
	}
	got, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != status || string(got) != body {
		t.Fatalf("handshake answered %d %q, want %d %q", resp.StatusCode, got, status, body)
	}
}

func (c *wsClient) sendRaw(data string) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	if err := c.c.Write(ctx, websocket.MessageText, []byte(data)); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *wsClient) send(v any) {
	c.t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		c.t.Fatal(err)
	}
	c.sendRaw(string(data))
}

func (c *wsClient) read() string {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	_, data, err := c.c.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	return string(data)
}

// expect reads one message and compares it byte for byte.
func (c *wsClient) expect(want string) {
	c.t.Helper()
	if got := c.read(); got != want {
		c.t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func (c *wsClient) expectError(code, message string) {
	c.t.Helper()
	data, err := json.Marshal(errorMessage(code, message))
	if err != nil {
		c.t.Fatal(err)
	}
	c.expect(string(data))
}

// expectClose reads and expects the close frame next, with no message
// before it.
func (c *wsClient) expectClose(code websocket.StatusCode, reason string) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	_, data, err := c.c.Read(ctx)
	if err == nil {
		c.t.Fatalf("got message %s, want close %d", data, code)
	}
	var ce websocket.CloseError
	if !errors.As(err, &ce) {
		c.t.Fatalf("read: %v, want close %d %q", err, code, reason)
	}
	if ce.Code != code || ce.Reason != reason {
		c.t.Fatalf("closed with %d %q, want %d %q", ce.Code, ce.Reason, code, reason)
	}
}

func (c *wsClient) authWith(token string) {
	c.t.Helper()
	c.send(map[string]string{"type": "auth", "token": token})
}

// auth authenticates and reads the two welcome messages.
func (c *wsClient) auth() {
	c.t.Helper()
	c.authWith(testToken)
	c.expect(wantAuthSuccess)
	c.expect(wantServerInfo)
}

func (c *wsClient) ping(ts float64) {
	c.t.Helper()
	c.send(map[string]any{"type": "ping", "timestamp": ts})
}

func pong(ts float64) string {
	return fmt.Sprintf(`{"type":"pong","timestamp":%v}`, ts)
}

// pump reads in the background, which also answers pings. It returns a
// channel of messages and one for the final read error.
func (c *wsClient) pump() (<-chan string, <-chan error) {
	msgs := make(chan string, 64)
	errs := make(chan error, 1)
	go func() {
		for {
			_, data, err := c.c.Read(context.Background())
			if err != nil {
				errs <- err
				return
			}
			msgs <- string(data)
		}
	}()
	return msgs, errs
}

// waitFor polls cond until it holds. Only for server side state that has
// no event to wait on.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitLimit)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func receive[T any](t *testing.T, what string, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(waitLimit):
		t.Fatalf("timed out waiting for %s", what)
		var zero T
		return zero
	}
}

func header(kv ...string) http.Header {
	h := http.Header{}
	for i := 0; i+1 < len(kv); i += 2 {
		h.Add(kv[i], kv[i+1])
	}
	return h
}
