package ws

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/hub/accesslog"
	"tmuxde/internal/hub/auth"
	"tmuxde/internal/protocol/client"
)

const chromeOnLinux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

func TestOrigin(t *testing.T) {
	tests := []struct {
		name    string
		origins []string
		origin  string
		allowed bool
	}{
		{"no origin header", []string{allowedOrigin}, "", true},
		{"listed origin", []string{"https://other.test", allowedOrigin}, allowedOrigin, true},
		{"unlisted origin", []string{allowedOrigin}, "http://evil.test", false},
		// Exact match, as the relay did. Config stores origins the way
		// browsers send them.
		{"other case", []string{allowedOrigin}, "http://TMUXDE.test", false},
		{"trailing slash", []string{allowedOrigin}, allowedOrigin + "/", false},
		{"other port", []string{allowedOrigin}, allowedOrigin + ":8080", false},
		{"null origin", []string{allowedOrigin}, "null", false},
		{"empty list allows all", nil, "http://evil.test", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, func(o *Options) { o.Origins = tt.origins })
			var hdr http.Header
			if tt.origin != "" {
				hdr = header("Origin", tt.origin)
			}
			if !tt.allowed {
				h.dialStatus(t, hdr, http.StatusForbidden, "Forbidden origin")
				if n := h.srv.Conns().Count(); n != 0 {
					t.Fatalf("Count = %d after a refused origin", n)
				}
				return
			}
			c := h.dial(t, hdr)
			c.auth()
		})
	}
}

func TestUpgradeOnlyOnRelayPath(t *testing.T) {
	h := newHarness(t, nil)
	tests := []struct {
		path   string
		status int
	}{
		{"/_relay/x", http.StatusNotFound},
		{"/", http.StatusNotFound},
		// A plain GET on the right path is not an upgrade.
		{Path, http.StatusUpgradeRequired},
	}
	for _, tt := range tests {
		rec := httptest.NewRecorder()
		h.srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tt.path, nil))
		if rec.Code != tt.status {
			t.Errorf("GET %s = %d, want %d", tt.path, rec.Code, tt.status)
		}
	}
}

func TestAuthTimeout(t *testing.T) {
	// Long enough that the reply to the invalid frame comes first.
	const timeout = 300 * time.Millisecond

	t.Run("fires without a valid frame", func(t *testing.T) {
		h := newHarness(t, func(o *Options) { o.AuthTimeout = timeout })
		c := h.dial(t, nil)
		// Invalid frames do not stop the timer.
		c.sendRaw("{}")
		c.expectError(CodeInvalidMessage, "message has no string type field")
		c.expect(`{"type":"auth:failure","reason":"Authentication timeout"}`)
		c.expectClose(websocket.StatusNoStatusRcvd, "")
	})

	t.Run("auth stops it", func(t *testing.T) {
		h := newHarness(t, func(o *Options) { o.AuthTimeout = timeout })
		c := h.dial(t, nil)
		c.auth()
		// Time passing is the point here.
		<-time.After(3 * timeout)
		c.ping(1)
		c.expect(pong(1))
	})
}

func TestFirstMessageMustBeAuth(t *testing.T) {
	h := newHarness(t, nil)
	c := h.dial(t, nil)
	c.ping(1)
	c.expect(`{"type":"auth:failure","reason":"First message must be auth"}`)
	c.expectClose(websocket.StatusNoStatusRcvd, "")
	if got := h.node.handledTypes(); len(got) != 0 {
		t.Fatalf("node handled %v before auth", got)
	}
}

func TestInvalidTokenAndLockout(t *testing.T) {
	clk := newClock()
	h := newHarness(t, func(o *Options) { o.Throttle = auth.NewThrottle(clk.Now) })

	fail := func(token, reason string) {
		t.Helper()
		c := h.dial(t, nil)
		c.authWith(token)
		c.expect(`{"type":"auth:failure","reason":"` + reason + `"}`)
		c.expectClose(websocket.StatusNoStatusRcvd, "")
	}
	for range auth.FailuresBeforeLockout {
		fail("wrong-token-0123456789", "Invalid token")
	}
	// Locked out: even the right token is refused, and not recorded.
	fail(testToken, "Too many failed attempts. Try again in 30s.")
	clk.Advance(10 * time.Second)
	fail(testToken, "Too many failed attempts. Try again in 20s.")

	clk.Advance(20 * time.Second)
	c := h.dial(t, nil)
	c.auth()
}

func TestAuthSuccess(t *testing.T) {
	t.Run("payload and label", func(t *testing.T) {
		h := newHarness(t, nil)
		c := h.dial(t, header("User-Agent", chromeOnLinux))
		c.authWith(testToken)
		c.expect(wantAuthSuccess)
		c.expect(wantServerInfo)

		if id := receive(t, "node open", h.node.opened); id != 1 {
			t.Fatalf("node opened connection %d, want 1", id)
		}
		list := h.srv.Conns().Summary()
		if len(list) != 1 || list[0].Label != "Chrome on Linux" || list[0].RemoteAddr != "127.0.0.1" {
			t.Fatalf("Summary = %+v", list)
		}
	})

	t.Run("unknown agent gets the fallback label", func(t *testing.T) {
		h := newHarness(t, nil)
		c := h.dial(t, header("User-Agent", "curl/8.5.0"))
		c.auth()
		if list := h.srv.Conns().Summary(); len(list) != 1 || list[0].Label != "A device" {
			t.Fatalf("Summary = %+v", list)
		}
	})

	t.Run("dictation feature", func(t *testing.T) {
		h := newHarness(t, func(o *Options) { o.DictationAvailable = func() bool { return true } })
		c := h.dial(t, nil)
		c.authWith(testToken)
		c.expect(strings.Replace(wantAuthSuccess, `"repo:graph"]`, `"repo:graph","dictation"]`, 1))
		c.expect(wantServerInfo)
	})

	t.Run("node open failure closes", func(t *testing.T) {
		h := newHarness(t, nil)
		h.node.openErr = errors.New("no tmux")
		c := h.dial(t, nil)
		c.auth()
		c.expectClose(websocket.StatusInternalError, "Internal error")
	})
}

func TestRateLimit(t *testing.T) {
	clk := newClock()
	h := newHarness(t, func(o *Options) {
		o.Now = clk.Now
		o.RateLimit = 2
	})
	c := h.dial(t, nil)

	// Before auth every frame counts, and a limited auth does not count
	// as the first message.
	c.sendRaw("nonsense")
	c.expectError(CodeInvalidMessage, "message is not a JSON object")
	c.sendRaw("nonsense")
	c.expectError(CodeInvalidMessage, "message is not a JSON object")
	c.authWith(testToken)
	c.expectError(CodeRateLimited, "Too many messages")

	clk.Advance(time.Second)
	c.auth()
	c.ping(1)
	c.expect(pong(1))
	c.ping(2)
	c.expectError(CodeRateLimited, "Too many messages")

	// The window is fixed. A new one starts a second later and the
	// connection is still open.
	clk.Advance(999 * time.Millisecond)
	c.ping(3)
	c.expectError(CodeRateLimited, "Too many messages")
	clk.Advance(time.Millisecond)
	c.ping(4)
	c.expect(pong(4))
}

func TestRouting(t *testing.T) {
	h := newHarness(t, nil)
	c := h.dial(t, nil)

	// Unknown types fail decode, as they failed the relay's schema. Before
	// auth they do not stop the auth timer and leave the socket open.
	c.sendRaw(`{"type":"device:approve","requestId":"r1","approve":true}`)
	c.expectError(CodeInvalidMessage, `unknown message type: "device:approve"`)
	c.auth()

	// One client for every step, so these are not subtests.
	c.ping(42.5)
	c.expect(pong(42.5))

	c.authWith(testToken)
	c.expectError(CodeAlreadyAuthenticated, "This connection is already authenticated.")

	// Dropped types are not in the registry.
	c.sendRaw(`{"type":"device:approve","requestId":"r1","approve":true}`)
	c.expectError(CodeInvalidMessage, `unknown message type: "device:approve"`)
	c.sendRaw(`{"type":"pair:offer"}`)
	c.expectError(CodeInvalidMessage, `unknown message type: "pair:offer"`)

	raw := `{"type":"session:kill"}`
	_, err := client.Decode([]byte(raw))
	if err == nil {
		t.Fatal("decode accepted a session:kill without name")
	}
	c.sendRaw(raw)
	c.expectError(CodeInvalidMessage, err.Error())

	c.send(map[string]string{"type": "session:list"})
	c.expectError(CodeHandlerError, "tmux is not running")

	// Hub replies and node messages keep the order of the requests.
	c.ping(1)
	c.send(map[string]string{"type": "session:kill", "name": "work"})
	c.send(map[string]string{"type": "session:list"})
	c.authWith(testToken)
	c.ping(2)
	c.expect(pong(1))
	c.expect(`{"type":"session:killed","name":"work"}`)
	c.expectError(CodeHandlerError, "tmux is not running")
	c.expectError(CodeAlreadyAuthenticated, "This connection is already authenticated.")
	c.expect(pong(2))

	// Dictation without a speech service answers as the relay did.
	c.send(map[string]string{"type": "dictation:start", "id": "d1"})
	c.expect(`{"type":"dictation:error","id":"d1","code":"UNAVAILABLE","message":"Dictation is not enabled on this machine"}`)
	c.send(map[string]string{"type": "dictation:audio", "id": "d1", "pcm": "AAAA"})
	c.expect(`{"type":"dictation:error","id":"d1","code":"NOT_FOUND","message":"No dictation is running"}`)
	c.send(map[string]string{"type": "dictation:stop", "id": "d1"})
	c.expect(`{"type":"dictation:error","id":"d1","code":"NOT_FOUND","message":"No dictation is running"}`)
	// Cancel says nothing. The pong comes next.
	c.send(map[string]string{"type": "dictation:cancel", "id": "d1"})
	c.ping(5)
	c.expect(pong(5))

	got := h.node.handledTypes()
	want := []string{"session:list", "session:kill", "session:list"}
	if !slices.Equal(got, want) {
		t.Fatalf("node handled %v, want %v", got, want)
	}
}

func TestFrameLimit(t *testing.T) {
	// framed pads a ping to exactly n bytes. Unknown keys are ignored.
	framed := func(n int) string {
		head, tail := `{"type":"ping","timestamp":7,"pad":"`, `"}`
		return head + strings.Repeat("x", n-len(head)-len(tail)) + tail
	}
	h := newHarness(t, nil)
	c := h.dial(t, nil)
	c.auth()
	c.sendRaw(framed(MaxFrame))
	c.expect(pong(7))
	c.sendRaw(framed(MaxFrame + 1))
	ce := readClose(t, c)
	if ce.Code != websocket.StatusMessageTooBig {
		t.Fatalf("closed with %d %q, want 1009", ce.Code, ce.Reason)
	}
	waitFor(t, "connection removal", func() bool { return h.srv.Conns().Count() == 0 })
}

// readClose reads until the close and returns it.
func readClose(t *testing.T, c *wsClient) websocket.CloseError {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	for {
		_, _, err := c.c.Read(ctx)
		if err == nil {
			continue
		}
		var ce websocket.CloseError
		if !errors.As(err, &ce) {
			t.Fatalf("read: %v, want a close frame", err)
		}
		return ce
	}
}

func TestCaps(t *testing.T) {
	tests := []struct {
		name            string
		maxConns, perIP int
		first, second   http.Header
		reason          string
	}{
		{"per address", 0, 1, nil, nil, "Too many connections from your address"},
		{
			"global", 1, 0,
			header("X-Forwarded-For", "192.0.2.1"), header("X-Forwarded-For", "192.0.2.2"),
			"Server at capacity",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, func(o *Options) {
				o.MaxConns = tt.maxConns
				o.MaxConnsPerAddr = tt.perIP
			})
			first := h.dial(t, tt.first)
			first.auth()
			// The upgrade succeeds. Admission is refused with a close.
			second := h.dial(t, tt.second)
			second.expectClose(websocket.StatusTryAgainLater, tt.reason)
			if n := h.srv.Conns().Count(); n != 1 {
				t.Fatalf("Count = %d, want 1", n)
			}
			first.ping(1)
			first.expect(pong(1))
		})
	}
}

func TestIdleReaper(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.IdleTimeout = 100 * time.Millisecond
		o.IdleSweep = 10 * time.Millisecond
	})
	c := h.dial(t, nil)
	c.auth()
	c.expectClose(websocket.StatusNormalClosure, "Idle timeout")
	waitFor(t, "connection removal", func() bool { return h.srv.Conns().Count() == 0 })
}

func TestLiveness(t *testing.T) {
	const interval = 50 * time.Millisecond
	h := newHarness(t, func(o *Options) { o.PingInterval = interval })

	// This one reads, so its pings get pongs.
	alive := h.dial(t, nil)
	alive.auth()
	msgs, _ := alive.pump()
	// This one never reads again, so no pong ever comes back.
	silent := h.dial(t, nil)
	silent.auth()

	waitFor(t, "the silent socket to be dropped", func() bool { return h.srv.Conns().Count() == 1 })
	// Time passing is the point here: several ticks with pongs.
	<-time.After(4 * interval)
	if n := h.srv.Conns().Count(); n != 1 {
		t.Fatalf("Count = %d, want the reading socket kept", n)
	}
	alive.ping(9)
	if got := receive(t, "pong", msgs); got != pong(9) {
		t.Fatalf("got %s, want pong", got)
	}
}

func TestShutdown(t *testing.T) {
	h := newHarness(t, nil)
	reader := h.dial(t, nil)
	reader.auth()
	_, errs := reader.pump()
	// Never reads, so it never answers the close. The grace period ends
	// it.
	silent := h.dial(t, nil)
	silent.auth()
	// Never authenticates. Shutdown closes it all the same.
	h.dial(t, nil)

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	if err := h.srv.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("Shutdown took %v", d)
	}
	err := receive(t, "reader close", errs)
	var ce websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != websocket.StatusGoingAway || ce.Reason != "Server shutting down" {
		t.Fatalf("reader got %v, want 1001 Server shutting down", err)
	}
	if n := h.srv.Conns().Count(); n != 0 {
		t.Fatalf("Count = %d after Shutdown", n)
	}
	h.dialStatus(t, nil, http.StatusServiceUnavailable, "Server shutting down")
}

func TestNodeLifecycle(t *testing.T) {
	h := newHarness(t, nil)

	// No node calls for a socket that never authenticates.
	c := h.dial(t, nil)
	c.c.Close(websocket.StatusNormalClosure, "")
	waitFor(t, "connection removal", func() bool { return h.srv.Conns().Count() == 0 })
	select {
	case id := <-h.node.opened:
		t.Fatalf("node opened %d without auth", id)
	case id := <-h.node.closed:
		t.Fatalf("node closed %d without auth", id)
	default:
	}

	c = h.dial(t, nil)
	c.auth()
	id := receive(t, "node open", h.node.opened)
	c.c.Close(websocket.StatusNormalClosure, "")
	if got := receive(t, "node close", h.node.closed); got != id {
		t.Fatalf("node closed %d, want %d", got, id)
	}
}

func TestAccessLog(t *testing.T) {
	clk := newClock()
	h := newHarness(t, func(o *Options) { o.Now = clk.Now })
	changed := make(chan struct{}, 8)
	unsubscribe := h.srv.Conns().OnChanged(func() { changed <- struct{}{} })
	defer unsubscribe()

	// A failed auth writes nothing.
	bad := h.dial(t, nil)
	bad.authWith("wrong-token-0123456789")
	bad.expect(`{"type":"auth:failure","reason":"Invalid token"}`)
	bad.expectClose(websocket.StatusNoStatusRcvd, "")

	c := h.dial(t, header("User-Agent", chromeOnLinux))
	c.auth()
	receive(t, "auth change", changed)
	clk.Advance(2500 * time.Millisecond)
	c.c.Close(websocket.StatusNormalClosure, "")
	// Removal fires after the disconnect line is written.
	receive(t, "removal change", changed)

	events, err := accesslog.Read(h.logDir)
	if err != nil {
		t.Fatal(err)
	}
	start := newClock().Now()
	want := []accesslog.Event{
		{At: start, Kind: accesslog.Connected, Transport: accesslog.Loopback},
		{At: start.Add(2500 * time.Millisecond), Kind: accesslog.Disconnected, Transport: accesslog.Loopback, Seconds: 3},
	}
	if len(events) != len(want) {
		t.Fatalf("events %+v, want %+v", events, want)
	}
	for i := range want {
		got := events[i]
		if !got.At.Equal(want[i].At) || got.Kind != want[i].Kind || got.Transport != want[i].Transport ||
			got.Seconds != want[i].Seconds || got.Label != "" {
			t.Errorf("event %d = %+v, want %+v", i, got, want[i])
		}
	}
}

func TestForwardedAddress(t *testing.T) {
	t.Run("honoured from loopback", func(t *testing.T) {
		h := newHarness(t, nil)
		c := h.dial(t, header("X-Forwarded-For", "192.0.2.7, 10.0.0.1"))
		c.auth()
		if list := h.srv.Conns().Summary(); len(list) != 1 || list[0].RemoteAddr != "192.0.2.7" {
			t.Fatalf("Summary = %+v", list)
		}
		c.c.Close(websocket.StatusNormalClosure, "")
		waitFor(t, "connection removal", func() bool { return h.srv.Conns().Count() == 0 })
		events, err := accesslog.Read(h.logDir)
		if err != nil || len(events) != 2 || events[0].Transport != accesslog.LAN {
			t.Fatalf("events %+v, %v, want lan transport", events, err)
		}
	})

	t.Run("honoured over a unix socket", func(t *testing.T) {
		sock := filepath.Join(t.TempDir(), "http.sock")
		ln, err := net.Listen("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		srv, err := New(Options{Token: testToken, Node: newFakeNode(), Logger: quietLogger()})
		if err != nil {
			t.Fatal(err)
		}
		mux := http.NewServeMux()
		mux.Handle(Path, srv)
		hs := httptest.NewUnstartedServer(mux)
		hs.Listener.Close()
		hs.Listener = ln
		hs.Start()
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
			defer cancel()
			_ = srv.Shutdown(ctx)
			hs.Close()
		})
		httpClient := &http.Client{Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", sock)
			},
		}}
		for _, tt := range []struct {
			hdr  http.Header
			want string
		}{
			{header("X-Forwarded-For", "192.0.2.9"), "192.0.2.9"},
			{nil, "unknown"},
		} {
			c := dialURL(t, "ws://tmuxde"+Path, &websocket.DialOptions{HTTPClient: httpClient, HTTPHeader: tt.hdr})
			c.authWith(testToken)
			c.read()
			c.read()
			list := srv.Conns().Summary()
			if len(list) != 1 || list[0].RemoteAddr != tt.want {
				t.Fatalf("Summary = %+v, want address %q", list, tt.want)
			}
			c.c.Close(websocket.StatusNormalClosure, "")
			waitFor(t, "connection removal", func() bool { return srv.Conns().Count() == 0 })
		}
	})
}

func TestNew(t *testing.T) {
	if _, err := New(Options{Node: newFakeNode()}); err == nil {
		t.Error("New accepted an empty token")
	}
	if _, err := New(Options{Token: testToken}); err == nil {
		t.Error("New accepted a nil node")
	}
}

func TestDisconnect(t *testing.T) {
	h := newHarness(t, nil)
	c := h.dial(t, nil)
	c.auth()
	id := receive(t, "node open", h.node.opened)
	if !h.srv.Conns().Disconnect("conn-1") {
		t.Fatal("Disconnect(conn-1) = false")
	}
	c.expectClose(websocket.StatusNormalClosure, "Closed from the machine")
	if got := receive(t, "node close", h.node.closed); got != id {
		t.Fatalf("node closed %d, want %d", got, id)
	}
	if h.srv.Conns().Disconnect("conn-1") {
		t.Fatal("second Disconnect(conn-1) = true")
	}
}
