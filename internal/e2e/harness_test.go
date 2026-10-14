package e2e

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/config"
	"tmuxde/internal/hub/dictation"
	"tmuxde/internal/hub/edge"
	"tmuxde/internal/hub/filehttp"
	"tmuxde/internal/hub/ws"
	"tmuxde/internal/node/local"
	"tmuxde/internal/protocol/server"
)

const (
	token  = "e2e-token-0123456789"
	origin = "http://tmuxde.e2e"
	// waitLimit bounds every wait for a reply or a tmux state. Nothing
	// should come close to it.
	waitLimit = 10 * time.Second
	// monitorLimit bounds a wait for the session monitor. Its session poll
	// runs every five seconds.
	monitorLimit = 15 * time.Second
	// clientReadLimit bounds one frame the test client reads. A repo:result
	// carries up to 512 KiB of Git output before JSON escaping.
	clientReadLimit = 8 << 20
)

// tmuxServer is a tmux server on its own socket in a temp dir. Cleanup
// kills it. Tests never talk to the default server.
type tmuxServer struct {
	t    *testing.T
	sock string
}

// newTmuxServer starts a server with one session, base, so it outlives
// every session a test kills. -f /dev/null keeps any user config out.
func newTmuxServer(t *testing.T) *tmuxServer {
	t.Helper()
	if err := exec.Command("tmux", "-V").Run(); err != nil {
		t.Skipf("tmux -V failed: %v", err)
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &tmuxServer{t: t, sock: filepath.Join(base, "sock")}
	t.Cleanup(func() {
		cmd := exec.Command("tmux", "-S", s.sock, "kill-server")
		cmd.Env = tmuxEnv()
		_ = cmd.Run()
	})
	s.must("new-session", "-d", "-s", "base", "-x", "80", "-y", "24", "/bin/sh")
	return s
}

// output runs a tmux command from outside tmuxde, as a user in their own
// terminal would, and returns stdout.
func (s *tmuxServer) output(args ...string) (string, error) {
	cmd := exec.Command("tmux", append([]string{"-f", "/dev/null", "-S", s.sock}, args...)...)
	cmd.Env = tmuxEnv()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("tmux %v: %w: %s", args, err, stderr.String())
	}
	return string(out), nil
}

func (s *tmuxServer) must(args ...string) string {
	s.t.Helper()
	out, err := s.output(args...)
	if err != nil {
		s.t.Fatal(err)
	}
	return out
}

// attachedClients is session_attached of one session: how many tmux
// clients are attached to it.
func (s *tmuxServer) attachedClients(name string) string {
	s.t.Helper()
	for line := range strings.SplitSeq(s.must("list-sessions", "-F", "#{session_name}\t#{session_attached}"), "\n") {
		if n, count, ok := strings.Cut(line, "\t"); ok && n == name {
			return count
		}
	}
	s.t.Fatalf("session %q is not listed", name)
	return ""
}

// waitTmux polls a tmux reading until it equals want.
func (s *tmuxServer) waitTmux(what, want string, read func() string) {
	s.t.Helper()
	deadline := time.Now().Add(waitLimit)
	for {
		got := read()
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("%s = %q, want %q", what, got, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// tmuxEnv keeps the caller's tmux and any token out of the test server.
func tmuxEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		switch k {
		case "TMUX", "TMUX_PANE", "AUTH_TOKEN":
			continue
		}
		env = append(env, kv)
	}
	return env
}

// lockedBuffer collects log records from many goroutines.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// stack is serve in miniature: the hub edge with the WebSocket server and
// the download handler on an httptest server, in front of the real local
// node on the test tmux socket.
type stack struct {
	t     *testing.T
	tmux  *tmuxServer
	node  *local.Node
	relay *ws.Server
	// url is the WebSocket URL.
	url string
	// base is the HTTP URL of the server, for GET /file.
	base string
	// home is HOME and the one allowed path, with symlinks resolved.
	// home/.ssh and home/.tmuxde are denied.
	home string
	// dictation is the speech service bridge, nil unless asked for.
	dictation *dictation.Bridge
}

// stackOptions configure newStackWith.
type stackOptions struct {
	// start runs the node's startup sweep and session monitor.
	start bool
	// before are sessions made from outside first.
	before []string
	// dictation, when set, builds a bridge from these options with the
	// stack's logger and runs its probe until the test ends, as serve
	// does. Nil leaves the ws default: no speech service.
	dictation *dictation.Options
}

// newStack builds the stack. The sessions named in before are made from
// outside first. With start the node then runs its startup sweep and the
// session monitor, as serve does before it listens.
func newStack(t *testing.T, start bool, before ...string) *stack {
	t.Helper()
	return newStackWith(t, stackOptions{start: start, before: before})
}

// newStackWith builds the stack as configured by o.
func newStackWith(t *testing.T, o stackOptions) *stack {
	t.Helper()
	tm := newTmuxServer(t)
	for _, name := range o.before {
		tm.must("new-session", "-d", "-s", name, "/bin/sh")
	}
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	logs := &lockedBuffer{}
	logger := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("server log:\n%s", logs.String())
		}
	})

	cfg := config.Config{
		AllowedPaths:     []string{home},
		Home:             home,
		TmuxSocket:       tm.sock,
		TmuxDefaultShell: "/bin/sh",
	}
	n := local.New(cfg, logger)
	if o.start {
		if err := n.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	// Runs after the relay shutdown below, as serve orders it.
	t.Cleanup(n.Stop)

	var bridge *dictation.Bridge
	if o.dictation != nil {
		opts := *o.dictation
		opts.Logger = logger
		bridge = dictation.New(opts)
		ctx, cancel := context.WithCancel(context.Background())
		done := bridge.StartProbe(ctx)
		t.Cleanup(func() {
			cancel()
			<-done
		})
	}

	relay, err := ws.New(ws.Options{
		Token:       token,
		Origins:     []string{origin},
		DefaultPath: home,
		Node:        n,
		Dictation:   bridge,
		Logger:      logger,
		Hostname:    func() string { return "e2e" },
		Uptime:      func() float64 { return 1 },
	})
	if err != nil {
		t.Fatal(err)
	}
	e := edge.New(edge.Options{Logger: logger})
	e.Handle(ws.Path, relay)
	e.Handle(filehttp.Path, filehttp.New(filehttp.Options{Token: token, Opener: n, Logger: logger}))
	srv := httptest.NewServer(e)
	t.Cleanup(srv.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
		defer cancel()
		if err := relay.Shutdown(ctx); err != nil {
			t.Errorf("relay shutdown: %v", err)
		}
	})
	return &stack{
		t:         t,
		tmux:      tm,
		node:      n,
		relay:     relay,
		url:       "ws" + strings.TrimPrefix(srv.URL, "http") + ws.Path,
		base:      srv.URL,
		home:      home,
		dictation: bridge,
	}
}

// client is a browser connection. A reader goroutine decodes every frame
// with server.Decode, so a frame the browser schema would refuse fails the
// test. Waits scan forward from a cursor and skip what they do not match,
// because live terminal output can land between any two replies.
type client struct {
	t    *testing.T
	name string
	conn *websocket.Conn
	done chan struct{}

	mu      sync.Mutex
	msgs    []server.Message
	changed chan struct{}
	readErr error
	cursor  int
}

// dial opens a connection with the allowed Origin, as the browser does.
func (s *stack) dial(name string) *client {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, s.url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {origin}},
	})
	if err != nil {
		s.t.Fatalf("dial %s: %v", name, err)
	}
	// Browsers take frames of any size. The library default of 32 KiB is
	// less than one file:content of 100 KiB.
	conn.SetReadLimit(clientReadLimit)
	c := &client{t: s.t, name: name, conn: conn, done: make(chan struct{}), changed: make(chan struct{})}
	go c.read()
	s.t.Cleanup(func() {
		conn.CloseNow()
		<-c.done
	})
	return c
}

func (c *client) read() {
	defer close(c.done)
	for {
		_, data, err := c.conn.Read(context.Background())
		if err != nil {
			c.mu.Lock()
			c.readErr = err
			close(c.changed)
			c.changed = make(chan struct{})
			c.mu.Unlock()
			return
		}
		msg, err := server.Decode(data)
		if err != nil {
			c.t.Errorf("%s got a frame the browser would refuse: %v: %s", c.name, err, data)
			continue
		}
		c.mu.Lock()
		c.msgs = append(c.msgs, msg)
		close(c.changed)
		c.changed = make(chan struct{})
		c.mu.Unlock()
	}
}

// send writes one frame as the browser would.
func (c *client) send(frame string) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
		c.t.Fatalf("%s send %s: %v", c.name, frame, err)
	}
}

// auth authenticates and checks the welcome. It returns once the node has
// the connection open, so a broadcast sent after it reaches this client.
func (c *client) auth() {
	c.t.Helper()
	c.send(`{"type":"auth","token":"` + token + `"}`)
	ok := expect(c, waitLimit, "auth:success", func(*server.AuthSuccess) bool { return true })
	if ok.ServerVersion != ws.ServerVersion || ok.Capabilities == nil || ok.Capabilities.ReadOnly {
		c.t.Fatalf("%s auth:success = %+v", c.name, ok)
	}
	info := expect(c, waitLimit, "server:info", func(*server.ServerInfo) bool { return true })
	if info.Hostname != "e2e" || info.DefaultPath == nil {
		c.t.Fatalf("%s server:info = %+v", c.name, info)
	}
	// The monitor may announce sessions right after, so only the first
	// two frames are checked.
	if got := typesOf(c.all()); len(got) < 2 || got[0] != "auth:success" || got[1] != "server:info" {
		c.t.Fatalf("%s welcome = %v, want auth:success then server:info first", c.name, got)
	}
	// The node opens the connection after the welcome is queued. A reply
	// from the node shows it is open.
	c.send(`{"type":"session:list"}`)
	expect(c, waitLimit, "session:list", func(*server.SessionList) bool { return true })
}

func (c *client) all() []server.Message {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.msgs)
}

// skip moves the cursor past everything received so far.
func (c *client) skip() {
	c.mu.Lock()
	c.cursor = len(c.msgs)
	c.mu.Unlock()
}

// wait blocks until match finds an index at or after the cursor in the
// messages so far, then moves the cursor past it.
func (c *client) wait(limit time.Duration, what string, match func(msgs []server.Message, from int) int) server.Message {
	c.t.Helper()
	deadline := time.After(limit)
	for {
		c.mu.Lock()
		msgs, from, changed, readErr := c.msgs, c.cursor, c.changed, c.readErr
		if i := match(msgs, from); i >= 0 {
			c.cursor = i + 1
			c.mu.Unlock()
			return msgs[i]
		}
		c.mu.Unlock()
		if readErr != nil {
			c.t.Fatalf("%s: connection ended waiting for %s: %v, got %v", c.name, what, readErr, typesOf(msgs[from:]))
		}
		select {
		case <-changed:
		case <-deadline:
			c.t.Fatalf("%s: timed out waiting for %s, got %v", c.name, what, typesOf(msgs[from:]))
			return nil
		}
	}
}

// expect waits for the next message of type T that pred accepts.
func expect[T server.Message](c *client, limit time.Duration, what string, pred func(T) bool) T {
	c.t.Helper()
	msg := c.wait(limit, what, func(msgs []server.Message, from int) int {
		for i := from; i < len(msgs); i++ {
			if m, ok := msgs[i].(T); ok && pred(m) {
				return i
			}
		}
		return -1
	})
	return msg.(T)
}

// expectError waits for the next error message and checks it.
func (c *client) expectError(code, text string) {
	c.t.Helper()
	e := expect(c, waitLimit, "error "+code, func(*server.Error) bool { return true })
	if e.Code != code || e.Message != text {
		c.t.Fatalf("%s: error %s %q, want %s %q", c.name, e.Code, e.Message, code, text)
	}
}

// waitOutput waits until the terminal output after the cursor contains
// s. tmux may split a line over several frames, so frames are joined.
func (c *client) waitOutput(s string) {
	c.t.Helper()
	c.wait(waitLimit, fmt.Sprintf("output %q", s), func(msgs []server.Message, from int) int {
		var b strings.Builder
		for i := from; i < len(msgs); i++ {
			if o, ok := msgs[i].(*server.TerminalOutput); ok {
				b.WriteString(o.Data)
				if strings.Contains(b.String(), s) {
					return i
				}
			}
		}
		return -1
	})
}

// closed waits until the server closes the connection and returns the
// close error.
func (c *client) closed() error {
	c.t.Helper()
	select {
	case <-c.done:
	case <-time.After(waitLimit):
		c.t.Fatalf("%s: connection still open", c.name)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.readErr
}

func typesOf(msgs []server.Message) []string {
	out := make([]string, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, m.WireType())
	}
	return out
}

func closeCode(err error) websocket.StatusCode {
	var ce websocket.CloseError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return -1
}
