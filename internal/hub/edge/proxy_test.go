package edge

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// testHost is the host the browser asks for in these tests.
const testHost = "tmuxde.test"

// upstream stands in for the web dev server. It records every path it
// serves, so tests can prove a path never reached it.
type upstream struct {
	*httptest.Server
	// release lets the stream handlers write their second part.
	release chan struct{}

	mu    sync.Mutex
	paths []string
}

func newUpstream(t *testing.T) *upstream {
	t.Helper()
	u := &upstream{release: make(chan struct{})}
	mux := http.NewServeMux()
	mux.HandleFunc("/hmr", echoSocket("web:"))
	mux.HandleFunc("/_relay", echoSocket("web:"))
	mux.HandleFunc("/assets/", func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Type", "text/javascript")
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		_, _ = io.WriteString(w, "console.log(1)")
	})
	mux.HandleFunc("/stream/events", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		u.writeInTwoParts(w, r, "data: one\n\n", "data: two\n\n")
	})
	mux.HandleFunc("/stream/sized", func(w http.ResponseWriter, r *http.Request) {
		// A known length makes ReverseProxy buffer unless FlushInterval
		// says otherwise.
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Length", strconv.Itoa(len("one\ntwo\n")))
		u.writeInTwoParts(w, r, "one\n", "two\n")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Content-Security-Policy", "default-src 'none'")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("X-Seen-Host", r.Host)
		h.Set("X-Seen-Forwarded-For", strings.Join(r.Header.Values("X-Forwarded-For"), "|"))
		h.Set("X-Seen-Forwarded-Host", r.Header.Get("X-Forwarded-Host"))
		h.Set("X-Seen-Forwarded-Proto", r.Header.Get("X-Forwarded-Proto"))
		_, _ = io.WriteString(w, "<!doctype html><title>tmuxde</title>")
	})
	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.paths = append(u.paths, r.URL.Path)
		u.mu.Unlock()
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(u.Close)
	return u
}

func (u *upstream) writeInTwoParts(w http.ResponseWriter, r *http.Request, first, rest string) {
	_, _ = io.WriteString(w, first)
	if err := http.NewResponseController(w).Flush(); err != nil {
		return
	}
	select {
	case <-u.release:
	case <-r.Context().Done():
		return
	}
	_, _ = io.WriteString(w, rest)
}

func (u *upstream) seen() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.paths...)
}

func (u *upstream) url(t *testing.T) *url.URL {
	t.Helper()
	target, err := url.Parse(u.URL)
	if err != nil {
		t.Fatal(err)
	}
	return target
}

// echoSocket accepts a WebSocket and answers every message with prefix
// plus the message. The default origin check passes only when the Host it
// sees matches the browser Origin, so a proxy that rewrites Host fails it.
func echoSocket(prefix string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			typ, msg, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if err := c.Write(r.Context(), typ, append([]byte(prefix), msg...)); err != nil {
				return
			}
		}
	}
}

func newEdgeServer(t *testing.T, web *url.URL, mount func(*Edge)) *httptest.Server {
	t.Helper()
	e := New(Options{DevWebURL: web, Logger: slog.New(slog.DiscardHandler)})
	if mount != nil {
		mount(e)
	}
	srv := httptest.NewServer(e)
	t.Cleanup(srv.Close)
	return srv
}

// get requests path from srv as a browser on testHost would.
func get(t *testing.T, srv *httptest.Server, path string, header http.Header) *http.Response {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, "GET", srv.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = testHost
	for name, values := range header {
		req.Header[name] = values
	}
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func readBody(t *testing.T, res *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// dial opens a WebSocket on srv as a browser page on testHost would.
func dial(t *testing.T, srv *httptest.Server, path string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	// Not cancelled before the test ends. A cancelled dial context may
	// close the upgraded connection.
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	t.Cleanup(cancel)
	c, res, err := websocket.Dial(ctx, "ws://"+srv.Listener.Addr().String()+path, &websocket.DialOptions{
		Host:       testHost,
		HTTPHeader: http.Header{"Origin": {"http://" + testHost}},
	})
	if c != nil {
		t.Cleanup(func() { c.CloseNow() })
	}
	return c, res, err
}

// roundTrip sends msg and returns the reply.
func roundTrip(t *testing.T, c *websocket.Conn, msg string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, []byte(msg)); err != nil {
		t.Fatal(err)
	}
	_, reply, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return string(reply)
}

func TestDevProxyPage(t *testing.T) {
	tests := []struct {
		name      string
		header    http.Header
		wantProto string
		socket    string
	}{
		{
			name:      "direct http",
			header:    http.Header{"X-Forwarded-For": {"203.0.113.9"}},
			wantProto: "http",
			socket:    "ws://" + testHost,
		},
		{
			name:      "behind caddy",
			header:    http.Header{"X-Forwarded-Proto": {"https"}},
			wantProto: "https",
			socket:    "wss://" + testHost,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			up := newUpstream(t)
			srv := newEdgeServer(t, up.url(t), nil)
			res := get(t, srv, "/login", tt.header)
			if res.StatusCode != http.StatusOK {
				t.Fatalf("status %d", res.StatusCode)
			}
			if body := readBody(t, res); body != "<!doctype html><title>tmuxde</title>" {
				t.Fatalf("body %q", body)
			}
			// Edge values replace the upstream ones, once each.
			wantSecurityHeaders(t, res.Header, tt.socket)
			seen := map[string]string{
				"X-Seen-Host":            testHost,
				"X-Seen-Forwarded-Host":  testHost,
				"X-Seen-Forwarded-For":   "127.0.0.1",
				"X-Seen-Forwarded-Proto": tt.wantProto,
			}
			for name, want := range seen {
				if got := res.Header.Get(name); got != want {
					t.Errorf("%s = %q, want %q", name, got, want)
				}
			}
		})
	}
}

func TestDevProxyAssetsPassThrough(t *testing.T) {
	up := newUpstream(t)
	srv := newEdgeServer(t, up.url(t), nil)
	res := get(t, srv, "/assets/index-abc123.js", nil)
	if res.StatusCode != http.StatusOK || readBody(t, res) != "console.log(1)" {
		t.Fatalf("status %d", res.StatusCode)
	}
	if got := res.Header.Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Errorf("Cache-Control = %q", got)
	}
	// Assets never got page headers. Whatever the dev server sends
	// stays as it is, and the edge adds nothing.
	if got := res.Header.Values("X-Frame-Options"); len(got) != 1 || got[0] != "SAMEORIGIN" {
		t.Errorf("X-Frame-Options = %q, want the upstream value", got)
	}
	for _, name := range []string{"Content-Security-Policy", "Permissions-Policy", "X-Content-Type-Options", "Referrer-Policy"} {
		if got := res.Header.Values(name); len(got) != 0 {
			t.Errorf("%s = %q, want none", name, got)
		}
	}
}

func TestDevProxyStreamsWithoutBuffering(t *testing.T) {
	tests := []struct {
		path, first, rest string
	}{
		{"/stream/events", "data: one\n\n", "data: two\n\n"},
		{"/stream/sized", "one\n", "two\n"},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			up := newUpstream(t)
			srv := newEdgeServer(t, up.url(t), nil)
			res := get(t, srv, tt.path, nil)
			// The upstream holds the rest until released. A buffering
			// proxy would block this read until the request times out.
			br := bufio.NewReader(res.Body)
			first := make([]byte, len(tt.first))
			if _, err := io.ReadFull(br, first); err != nil {
				t.Fatalf("first part: %v", err)
			}
			if string(first) != tt.first {
				t.Fatalf("first part %q, want %q", first, tt.first)
			}
			close(up.release)
			rest, err := io.ReadAll(br)
			if err != nil {
				t.Fatal(err)
			}
			if string(rest) != tt.rest {
				t.Fatalf("rest %q, want %q", rest, tt.rest)
			}
		})
	}
}

func TestDevProxyNeverForwardsHubPaths(t *testing.T) {
	up := newUpstream(t)
	srv := newEdgeServer(t, up.url(t), nil)
	for _, path := range []string{"/_relay", "/_relay/x", "/file", "/file?path=/etc/passwd", "/file/x", "/health/", "/health?x=1"} {
		t.Run(path, func(t *testing.T) {
			res := get(t, srv, path, nil)
			if body := readBody(t, res); res.StatusCode != http.StatusNotFound || body != "Not found" {
				t.Fatalf("got %d %q, want 404 Not found", res.StatusCode, body)
			}
			wantSecurityHeaders(t, res.Header, "ws://"+testHost)
		})
	}
	t.Run("health", func(t *testing.T) {
		res := get(t, srv, "/health", nil)
		if body := readBody(t, res); !strings.HasPrefix(body, `{"status":"ok",`) {
			t.Fatalf("body %q", body)
		}
	})
	t.Run("relay upgrade", func(t *testing.T) {
		_, res, err := dial(t, srv, "/_relay")
		if err == nil || res == nil || res.StatusCode != http.StatusNotFound {
			t.Fatalf("dial /_relay: res %v err %v, want 404", res, err)
		}
	})
	if seen := up.seen(); len(seen) != 0 {
		t.Fatalf("dev server saw %q, want nothing", seen)
	}
}

// TestUpgradeRouting ports the relay attachUpgrade tests. Only /_relay
// belongs to the hub. Every other upgrade goes to the dev server, or gets
// an answer at once when there is none. Never a hang.
func TestUpgradeRouting(t *testing.T) {
	tests := []struct {
		name      string
		web       bool
		relay     bool
		path      string
		wantReply string
		wantCode  int
	}{
		{name: "routes the relay path to the relay", relay: true, path: "/_relay", wantReply: "relay:hi"},
		{name: "refuses other paths when there is no dev server", relay: true, path: "/hmr", wantCode: http.StatusNotFound},
		{name: "hands other paths to the dev server", web: true, relay: true, path: "/hmr", wantReply: "web:hi"},
		{name: "keeps the relay path when a dev server exists", web: true, relay: true, path: "/_relay?token=x", wantReply: "relay:hi"},
		{name: "refuses the relay path while nothing is mounted", web: true, path: "/_relay", wantCode: http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			up := newUpstream(t)
			var web *url.URL
			if tt.web {
				web = up.url(t)
			}
			srv := newEdgeServer(t, web, func(e *Edge) {
				if tt.relay {
					e.Handle("/_relay", echoSocket("relay:"))
				}
			})
			c, res, err := dial(t, srv, tt.path)
			if tt.wantCode != 0 {
				if err == nil || res == nil || res.StatusCode != tt.wantCode {
					t.Fatalf("res %v err %v, want status %d", res, err, tt.wantCode)
				}
				return
			}
			if err != nil {
				t.Fatalf("dial: %v", err)
			}
			if res.StatusCode != http.StatusSwitchingProtocols {
				t.Fatalf("status %d, want 101", res.StatusCode)
			}
			if got := roundTrip(t, c, "hi"); got != tt.wantReply {
				t.Fatalf("reply %q, want %q", got, tt.wantReply)
			}
			if err := c.Close(websocket.StatusNormalClosure, ""); err != nil {
				t.Fatalf("close: %v", err)
			}
			if strings.HasPrefix(tt.wantReply, "relay:") {
				if seen := up.seen(); len(seen) != 0 {
					t.Fatalf("dev server saw %q, want nothing", seen)
				}
			}
		})
	}
}

func TestDevProxyUnavailable(t *testing.T) {
	// A port with nothing listening.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()

	logs := &lockedBuffer{}
	e := New(Options{
		DevWebURL: &url.URL{Scheme: "http", Host: addr},
		Logger:    slog.New(slog.NewTextHandler(logs, nil)),
	})
	srv := httptest.NewServer(e)
	t.Cleanup(srv.Close)

	for _, path := range []string{"/login", "/assets/a.js"} {
		t.Run(path, func(t *testing.T) {
			res := get(t, srv, path, nil)
			if body := readBody(t, res); res.StatusCode != http.StatusBadGateway || body != "Bad gateway" {
				t.Fatalf("got %d %q, want 502 Bad gateway", res.StatusCode, body)
			}
			// An answer from the edge itself, so it has the headers.
			wantSecurityHeaders(t, res.Header, "ws://"+testHost)
		})
	}
	if got := logs.String(); !strings.Contains(got, "web dev server request failed") {
		t.Fatalf("log %q, want a warning", got)
	}
}

type lockedBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}
