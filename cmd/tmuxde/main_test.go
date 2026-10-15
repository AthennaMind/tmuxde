package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/config"
	"tmuxde/web"
)

func TestRun(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		code      int
		stdout    string
		stderrHas string
	}{
		{name: "no command", args: nil, code: 2, stderrHas: "Usage: tmuxde <command>"},
		{name: "version", args: []string{"version"}, code: 0, stdout: "dev\n"},
		{name: "version extra arg", args: []string{"version", "now"}, code: 2, stderrHas: `unexpected argument "now"`},
		{name: "version help", args: []string{"version", "-h"}, code: 0, stderrHas: "Usage: tmuxde version"},
		{name: "help", args: []string{"help"}, code: 0, stdout: usage},
		{name: "unknown", args: []string{"start"}, code: 2, stderrHas: `unknown command "start"`},
		{name: "serve help", args: []string{"serve", "-h"}, code: 0, stderrHas: "AUTH_TOKEN"},
		{name: "serve bad flag", args: []string{"serve", "-port", "1"}, code: 2, stderrHas: "flag provided but not defined"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := run(tt.args, &stdout, &stderr)
			if code != tt.code {
				t.Fatalf("exit %d, want %d, stderr %s", code, tt.code, stderr.String())
			}
			if tt.stdout != "" && stdout.String() != tt.stdout {
				t.Fatalf("stdout %q, want %q", stdout.String(), tt.stdout)
			}
			if !strings.Contains(stderr.String(), tt.stderrHas) {
				t.Fatalf("stderr %q does not contain %q", stderr.String(), tt.stderrHas)
			}
		})
	}
}

func TestServeRefusesBadConfig(t *testing.T) {
	t.Setenv("HOME", "/home/dev")
	// Too short, and no reason text contains it.
	t.Setenv("AUTH_TOKEN", "leakcanary")
	t.Setenv("ALLOWED_PATHS", "")
	t.Setenv("CORS_ORIGINS", "https://tmuxde.example")
	var stdout, stderr bytes.Buffer
	if code := run([]string{"serve"}, &stdout, &stderr); code != 1 {
		t.Fatalf("exit %d", code)
	}
	out := stderr.String()
	for _, want := range []string{`"variable":"AUTH_TOKEN"`, `"variable":"ALLOWED_PATHS"`, `"level":"ERROR"`} {
		if !strings.Contains(out, want) {
			t.Errorf("stderr %s does not contain %s", out, want)
		}
	}
	if strings.Contains(out, "leakcanary") {
		t.Errorf("token value leaked: %s", out)
	}
}

func TestLoadConfigDropsToken(t *testing.T) {
	const token = "0123456789abcdef"
	t.Setenv("HOME", "/home/dev")
	t.Setenv("AUTH_TOKEN", token)
	t.Setenv("ALLOWED_PATHS", "/home/dev")
	t.Setenv("CORS_ORIGINS", "https://tmuxde.example")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AuthToken != token {
		t.Fatalf("token %q", cfg.AuthToken)
	}
	if v, ok := os.LookupEnv("AUTH_TOKEN"); ok {
		t.Fatalf("AUTH_TOKEN still set to %q", v)
	}
	for _, kv := range os.Environ() {
		if strings.Contains(kv, token) {
			t.Fatalf("token still in environment: %s", kv)
		}
	}
}

func TestNodeConfig(t *testing.T) {
	cfg := config.Config{
		AuthToken:    testToken,
		AllowedPaths: []string{"/home/dev"},
		CORSOrigins:  []string{"https://tmuxde.example"},
		Home:         "/home/dev",
		TmuxSocket:   "/run/tmux/default",
	}
	got := nodeConfig(cfg)
	if got.AuthToken != "" || got.CORSOrigins != nil {
		t.Fatalf("node config keeps token %q and origins %v", got.AuthToken, got.CORSOrigins)
	}
	if got.Home != cfg.Home || got.TmuxSocket != cfg.TmuxSocket || len(got.AllowedPaths) != 1 {
		t.Fatalf("node config lost other fields: %+v", got)
	}
	if cfg.AuthToken != testToken || len(cfg.CORSOrigins) != 1 {
		t.Fatalf("hub config changed: token %q, origins %v", cfg.AuthToken, cfg.CORSOrigins)
	}
}

const testToken = "0123456789abcdef"

// testConfig is a minimal valid configuration. tmux points at a socket in
// a temp dir that nothing listens on, so the node never reaches the tmux
// server of the machine.
func testConfig(t *testing.T) config.Config {
	t.Helper()
	return config.Config{
		AuthToken:        testToken,
		AllowedPaths:     []string{t.TempDir()},
		CORSOrigins:      []string{"https://tmuxde.example"},
		ConfigDir:        t.TempDir(),
		Home:             t.TempDir(),
		IdleTimeout:      config.DefaultIdleTimeout,
		TmuxSocket:       filepath.Join(t.TempDir(), "tmux.sock"),
		TmuxDefaultShell: "/bin/sh",
	}
}

// testApp builds the serve handler from testConfig, without a web build,
// so pages are 404.
func testApp(t *testing.T) (*app, config.Config) {
	t.Helper()
	cfg := testConfig(t)
	a, err := newApp(cfg, nil, discardLogger(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return a, cfg
}

// stopWait bounds a whole serve shutdown in tests: the WebSocket step and
// the HTTP step, each up to shutdownTimeout, plus slack for -race.
const stopWait = 3 * shutdownTimeout

// testListener closes started on the first Accept, which shows that Serve
// runs. It also reports the remote address of every accepted connection.
// Addresses past the buffer of 64 are dropped. Tests here open far fewer.
type testListener struct {
	net.Listener
	once     sync.Once
	started  chan struct{}
	accepted chan string
}

func newTestListener(ln net.Listener) *testListener {
	return &testListener{Listener: ln, started: make(chan struct{}), accepted: make(chan string, 64)}
}

func (l *testListener) Accept() (net.Conn, error) {
	l.once.Do(func() { close(l.started) })
	c, err := l.Listener.Accept()
	if err == nil {
		select {
		case l.accepted <- c.RemoteAddr().String():
		default:
		}
	}
	return c, err
}

// waitAccepted waits until the server has accepted the connection whose
// remote address is addr.
func (l *testListener) waitAccepted(t *testing.T, addr string) {
	t.Helper()
	deadline := time.After(stopWait)
	for {
		select {
		case got := <-l.accepted:
			if got == addr {
				return
			}
		case <-deadline:
			t.Fatalf("server did not accept %s", addr)
		}
	}
}

func startServer(t *testing.T, ln net.Listener) (stop func() error) {
	t.Helper()
	a, _ := testApp(t)
	return startApp(t, ln, a)
}

// startApp runs serve in the background and returns once Serve accepts.
// stop cancels serve and returns its result. A *testListener is used as
// it is. Any other listener is wrapped in one.
func startApp(t *testing.T, ln net.Listener, a *app) (stop func() error) {
	t.Helper()
	tl, ok := ln.(*testListener)
	if !ok {
		tl = newTestListener(ln)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- serve(ctx, tl, a, discardLogger()) }()
	select {
	case <-tl.started:
	case err := <-done:
		t.Fatalf("serve returned before it accepted: %v", err)
	case <-time.After(stopWait):
		t.Fatal("server did not start")
	}
	return func() error {
		t.Helper()
		cancel()
		select {
		case err := <-done:
			return err
		case <-time.After(stopWait):
			t.Fatal("server did not stop")
			return nil
		}
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

func checkHealth(t *testing.T, c *http.Client, base string) {
	t.Helper()
	resp, err := c.Get(base + "/health")
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Status string   `json:"status"`
		Uptime *float64 `json:"uptime"`
	}
	err = json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	if err != nil || resp.StatusCode != http.StatusOK || body.Status != "ok" || body.Uptime == nil || *body.Uptime < 0 {
		t.Fatalf("health %d %+v %v", resp.StatusCode, body, err)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content type %q", ct)
	}
}

func TestServeTCP(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stop := startServer(t, ln)
	base := "http://" + ln.Addr().String()
	// Own transport, so nothing it keeps outlives the test. It may hold a
	// spare connection it never used. The server must not wait for it.
	transport := &http.Transport{}
	t.Cleanup(transport.CloseIdleConnections)
	noRedirect := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	checkHealth(t, noRedirect, base)

	for _, tc := range []struct {
		method, path string
		code         int
		location     string
	}{
		// The edge answers /health for any method, as the relay did.
		{http.MethodPost, "/health", http.StatusOK, ""},
		{http.MethodHead, "/health", http.StatusOK, ""},
		{http.MethodGet, "/health?x=1", http.StatusNotFound, ""},
		// No web dev server configured: nothing else is served.
		{http.MethodGet, "/missing", http.StatusNotFound, ""},
		{http.MethodGet, "/start", http.StatusFound, "/login"},
		{http.MethodOptions, "/anything", http.StatusNoContent, ""},
		// A plain GET on the relay path is not an upgrade.
		{http.MethodGet, "/_relay", http.StatusUpgradeRequired, ""},
		{http.MethodGet, "/_relay/x", http.StatusNotFound, ""},
		// Downloads are mounted, and need the token.
		{http.MethodGet, "/file?path=/x", http.StatusUnauthorized, ""},
		{http.MethodGet, "/file/x?path=/x", http.StatusNotFound, ""},
	} {
		req, _ := http.NewRequest(tc.method, base+tc.path, nil)
		resp, err := noRedirect.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != tc.code || resp.Header.Get("Location") != tc.location {
			t.Errorf("%s %s = %d %q, want %d %q", tc.method, tc.path, resp.StatusCode, resp.Header.Get("Location"), tc.code, tc.location)
		}
		if resp.Header.Get("X-Frame-Options") != "DENY" {
			t.Errorf("%s %s has no security headers", tc.method, tc.path)
		}
	}
	start := time.Now()
	if err := stop(); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if elapsed := time.Since(start); elapsed >= shutdownTimeout {
		t.Fatalf("shutdown took %v, it waited for a connection", elapsed)
	}
	if _, err := http.Get(base + "/health"); err == nil {
		t.Fatal("server still answers after shutdown")
	}
}

// TestServeClosesUnusedConnections holds a connection that never sends a
// request, as a browser does with a spare one. net/http Shutdown would wait
// five seconds for it. serve closes it at once.
func TestServeClosesUnusedConnections(t *testing.T) {
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln := newTestListener(raw)
	stop := startServer(t, ln)

	spare, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer spare.Close()
	ln.waitAccepted(t, spare.LocalAddr().String())

	// One more connection with a request. It is idle at shutdown.
	transport := &http.Transport{}
	t.Cleanup(transport.CloseIdleConnections)
	checkHealth(t, &http.Client{Transport: transport}, "http://"+ln.Addr().String())

	start := time.Now()
	if err := stop(); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if elapsed := time.Since(start); elapsed >= shutdownTimeout {
		t.Fatalf("shutdown took %v, it waited for the unused connection", elapsed)
	}
	if err := spare.SetReadDeadline(time.Now().Add(stopWait)); err != nil {
		t.Fatal(err)
	}
	if n, err := spare.Read(make([]byte, 1)); n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("unused connection read %d bytes, error %v, want EOF", n, err)
	}
}

// TestServeCanceledBeforeStart stops serve before its server goroutine got
// to Accept. serve must still close the listener and return.
func TestServeCanceledBeforeStart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "http.sock")
	ln, err := listen(config.Listen{Network: "unix", Address: path})
	if err != nil {
		t.Fatal(err)
	}
	a, _ := testApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan error, 1)
	go func() { done <- serve(ctx, ln, a, discardLogger()) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve: %v", err)
		}
	case <-time.After(stopWait):
		t.Fatal("server did not stop")
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("listener still open: %v", err)
	}
}

// TestServeRelay drives /_relay through the edge, the WebSocket server and
// the local node, then shuts down with the socket open.
func TestServeRelay(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	a, cfg := testApp(t)
	stop := startApp(t, ln, a)
	url := "ws://" + ln.Addr().String() + "/_relay"

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// A foreign origin never gets an upgrade.
	_, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://evil.example"}},
	})
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin: %v %v", resp, err)
	}

	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://tmuxde.example"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	write := func(msg string) {
		t.Helper()
		if err := c.Write(ctx, websocket.MessageText, []byte(msg)); err != nil {
			t.Fatal(err)
		}
	}
	read := func() string {
		t.Helper()
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}

	write(`{"type":"auth","token":"` + testToken + `"}`)
	if got := read(); !strings.HasPrefix(got, `{"type":"auth:success","serverVersion":"1.0.0",`) {
		t.Fatalf("got %s, want auth:success", got)
	}
	wantInfo := `"defaultPath":"` + cfg.AllowedPaths[0] + `"}`
	if got := read(); !strings.HasPrefix(got, `{"type":"server:info",`) || !strings.HasSuffix(got, wantInfo) {
		t.Fatalf("got %s, want server:info ending %s", got, wantInfo)
	}
	// No tmux server runs on the test socket, so there are no sessions.
	write(`{"type":"session:list"}`)
	if got, want := read(), `{"type":"session:list","sessions":[]}`; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
	if _, err := os.Stat(filepath.Join(cfg.ConfigDir, "access.log")); err != nil {
		t.Fatalf("access log: %v", err)
	}

	// Read in the background, so the close handshake can finish.
	errs := make(chan error, 1)
	go func() {
		_, _, err := c.Read(ctx)
		errs <- err
	}()
	if err := stop(); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	var ce websocket.CloseError
	if err := <-errs; !errors.As(err, &ce) || ce.Code != websocket.StatusGoingAway || ce.Reason != "Server shutting down" {
		t.Fatalf("socket ended with %v, want 1001 Server shutting down", err)
	}
}

// TestServeFile downloads through the serve handler: the hub checks the
// token, the node checks the path against ALLOWED_PATHS and opens it.
func TestServeFile(t *testing.T) {
	a, cfg := testApp(t)
	root := cfg.AllowedPaths[0]
	inside := filepath.Join(root, "note.pdf")
	if err := os.WriteFile(inside, []byte("%PDF-1.4 e2e"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret.pdf")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, path, token string
		code              int
		body, mime        string
	}{
		{"inside", inside, testToken, http.StatusOK, "%PDF-1.4 e2e", "application/pdf"},
		{"wrong token", inside, "wrong-token-0123456789", http.StatusUnauthorized, "Unauthorized", ""},
		{"outside the allowed paths", outside, testToken, http.StatusForbidden, "Access denied", ""},
		{"directory", root, testToken, http.StatusNotFound, "Not a file", ""},
		{"missing", filepath.Join(root, "absent.pdf"), testToken, http.StatusNotFound, "File not found", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/file?path="+url.QueryEscape(tt.path), nil)
			req.Header.Set("Authorization", "Bearer "+tt.token)
			rec := httptest.NewRecorder()
			a.handler.ServeHTTP(rec, req)
			if rec.Code != tt.code || rec.Body.String() != tt.body {
				t.Fatalf("GET %s = %d %q, want %d %q", tt.path, rec.Code, rec.Body.String(), tt.code, tt.body)
			}
			if tt.mime != "" && rec.Header().Get("Content-Type") != tt.mime {
				t.Fatalf("content type %q, want %q", rec.Header().Get("Content-Type"), tt.mime)
			}
			if rec.Header().Get("X-Frame-Options") != "DENY" {
				t.Fatal("no security headers")
			}
		})
	}
}

// testSite is a web build with a page and a hashed asset.
func testSite() fstest.MapFS {
	return fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html><title>tmuxde</title>")},
		"assets/app-abc123.js": {Data: []byte("console.log(1)")},
	}
}

// siteApp builds the serve handler from cfg with site and returns its log.
func siteApp(t *testing.T, cfg config.Config, site fs.FS) (*app, *lockedBuffer) {
	t.Helper()
	logs := &lockedBuffer{}
	a, err := newApp(cfg, site, slog.New(slog.NewJSONHandler(logs, nil)), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return a, logs
}

// wantLogged fails unless the log has exactly n lines with level and msg.
func wantLogged(t *testing.T, logs *lockedBuffer, level, msg string, n int) {
	t.Helper()
	out := logs.String()
	needle := `"level":"` + level + `","msg":"` + msg + `"`
	if got := strings.Count(out, needle); got != n {
		t.Fatalf("log has %d lines with %s, want %d: %s", got, needle, n, out)
	}
}

// TestServeEmbeddedSite serves the web build when no dev web URL is set:
// pages and app routes get index.html with the security headers, assets
// come from the build without them. Hub routes still win.
func TestServeEmbeddedSite(t *testing.T) {
	site := testSite()
	a, logs := siteApp(t, testConfig(t), site)
	wantLogged(t, logs, "INFO", "web build embedded", 1)
	wantLogged(t, logs, "ERROR", "web build missing", 0)

	tests := []struct {
		path    string
		code    int
		body    string
		cache   string
		headers bool
	}{
		{"/", 200, string(site["index.html"].Data), "no-cache", true},
		{"/s/work", 200, string(site["index.html"].Data), "no-cache", true},
		{"/assets/app-abc123.js", 200, "console.log(1)", "public, max-age=31536000, immutable", false},
		{"/assets/app-old999.js", 404, "Not found", "", false},
		{"/missing.css", 404, "Not found", "", true},
		{"/file?path=/x", 401, "Unauthorized", "", true},
		{"/_relay", 426, "", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			a.handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tt.path, nil))
			if rec.Code != tt.code || (tt.body != "" && strings.TrimSpace(rec.Body.String()) != tt.body) {
				t.Fatalf("GET %s = %d %q, want %d %q", tt.path, rec.Code, rec.Body, tt.code, tt.body)
			}
			if got := rec.Header().Get("Cache-Control"); tt.cache != "" && got != tt.cache {
				t.Fatalf("Cache-Control = %q, want %q", got, tt.cache)
			}
			if got := rec.Header().Get("X-Frame-Options") == "DENY"; got != tt.headers {
				t.Fatalf("security headers %v, want %v", got, tt.headers)
			}
		})
	}
	checkHealthHandler(t, a.handler)
}

// TestServeWithoutWebBuild covers a binary built without the web app and
// run without a dev web URL. Pages answer 503, the gap is logged once at
// startup, and the hub routes still work. On TCP the log line is an error.
// On a unix socket it is a warning, since Caddy sends pages elsewhere.
func TestServeWithoutWebBuild(t *testing.T) {
	tests := []struct {
		name   string
		listen config.Listen
		level  string
	}{
		{"tcp", config.Listen{Network: "tcp", Address: "127.0.0.1:24200"}, "ERROR"},
		{"unix", config.Listen{Network: "unix", Address: "/run/tmuxde/dev/http-dev.sock"}, "WARN"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := testConfig(t)
			cfg.Listen = tt.listen
			a, logs := siteApp(t, cfg, fstest.MapFS{".gitkeep": {}})
			for _, path := range []string{"/", "/login", "/s/work", "/assets/app-abc123.js"} {
				rec := httptest.NewRecorder()
				a.handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
				if rec.Code != http.StatusServiceUnavailable || rec.Body.String() != "web build missing" {
					t.Fatalf("GET %s = %d %q, want 503 web build missing", path, rec.Code, rec.Body)
				}
			}
			other := map[string]string{"ERROR": "WARN", "WARN": "ERROR"}[tt.level]
			wantLogged(t, logs, tt.level, "web build missing", 1)
			wantLogged(t, logs, other, "web build missing", 0)
			wantLogged(t, logs, "INFO", "web build embedded", 0)
			checkHealthHandler(t, a.handler)
		})
	}
}

// TestServeDevWebURLWinsOverSite proxies pages to the dev web URL even
// when a build is embedded. The log says which one serves.
func TestServeDevWebURLWinsOverSite(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "dev "+r.URL.Path)
	}))
	t.Cleanup(upstream.Close)
	cfg := testConfig(t)
	var err error
	if cfg.DevWebURL, err = url.Parse(upstream.URL); err != nil {
		t.Fatal(err)
	}
	for name, site := range map[string]fs.FS{"with a build": testSite(), "without a build": fstest.MapFS{}} {
		t.Run(name, func(t *testing.T) {
			a, logs := siteApp(t, cfg, site)
			for _, path := range []string{"/s/work", "/assets/app-abc123.js"} {
				rec := httptest.NewRecorder()
				a.handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
				if rec.Code != http.StatusOK || rec.Body.String() != "dev "+path {
					t.Fatalf("GET %s = %d %q, want the dev server", path, rec.Code, rec.Body)
				}
			}
			wantLogged(t, logs, "INFO", "web pages from dev server", 1)
			wantLogged(t, logs, "ERROR", "web build missing", 0)
			wantEmbedded := `"embeddedBuild":` + fmt.Sprint(name == "with a build")
			if out := logs.String(); !strings.Contains(out, wantEmbedded) {
				t.Fatalf("log %s lacks %s", out, wantEmbedded)
			}
		})
	}
}

// checkHealthHandler checks /health on h without a server.
func checkHealthHandler(t *testing.T, h http.Handler) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Body.String(), `{"status":"ok",`) {
		t.Fatalf("health %d %q", rec.Code, rec.Body)
	}
}

func TestServeUnixSocket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "http.sock")
	ln, err := listen(config.Listen{Network: "unix", Address: path})
	if err != nil {
		t.Fatal(err)
	}
	stop := startServer(t, ln)
	c := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", path)
		},
	}}
	checkHealth(t, c, "http://tmuxde")
	if err := stop(); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("socket left behind: %v", err)
	}
}

func TestRemoveStaleSocket(t *testing.T) {
	dir := t.TempDir()

	file := filepath.Join(dir, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := removeStaleSocket(file); err == nil || !strings.Contains(err.Error(), "not a socket") {
		t.Fatalf("regular file: %v", err)
	}

	if err := removeStaleSocket(filepath.Join(dir, "absent")); err != nil {
		t.Fatalf("absent path: %v", err)
	}

	live := filepath.Join(dir, "live.sock")
	ln, err := net.Listen("unix", live)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err := removeStaleSocket(live); err == nil || !strings.Contains(err.Error(), "in use") {
		t.Fatalf("live socket: %v", err)
	}

	stale := filepath.Join(dir, "stale.sock")
	sl, err := net.Listen("unix", stale)
	if err != nil {
		t.Fatal(err)
	}
	sl.(*net.UnixListener).SetUnlinkOnClose(false)
	sl.Close()
	if err := removeStaleSocket(stale); err != nil {
		t.Fatalf("stale socket: %v", err)
	}
	if _, err := os.Lstat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale socket still there: %v", err)
	}
}

// TestServeRefusesWithoutTmux ports the relay's startup check. Without
// tmux in PATH serve exits 1 with a clear error and never listens.
func TestServeRefusesWithoutTmux(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "http.sock")
	t.Setenv("HOME", dir)
	t.Setenv("AUTH_TOKEN", testToken)
	t.Setenv("ALLOWED_PATHS", dir)
	t.Setenv("CORS_ORIGINS", "https://tmuxde.example")
	t.Setenv("TMUXDE_LISTEN", "unix:"+sock)
	t.Setenv("TMUXDE_CONFIG_DIR", filepath.Join(dir, "state"))
	t.Setenv("TMUX_SOCKET", filepath.Join(dir, "tmux.sock"))
	t.Setenv("PATH", t.TempDir())

	var stdout, stderr bytes.Buffer
	if code := run([]string{"serve"}, &stdout, &stderr); code != 1 {
		t.Fatalf("exit %d, want 1, stderr %s", code, stderr.String())
	}
	out := stderr.String()
	for _, want := range []string{`"level":"ERROR"`, `"msg":"node start failed"`, "tmux is not installed or not found in PATH"} {
		if !strings.Contains(out, want) {
			t.Errorf("stderr %s does not contain %s", out, want)
		}
	}
	if strings.Contains(out, `"msg":"listening"`) {
		t.Errorf("serve listened without tmux: %s", out)
	}
	if _, err := os.Lstat(sock); !os.IsNotExist(err) {
		t.Fatalf("listen socket exists: %v", err)
	}
}

// testTmux is a tmux server on its own socket in a temp dir. Cleanup kills
// it. Tests never talk to the default server.
type testTmux struct {
	t    *testing.T
	sock string
}

func newTestTmux(t *testing.T) *testTmux {
	t.Helper()
	if err := exec.Command("tmux", "-V").Run(); err != nil {
		t.Skipf("tmux -V failed: %v", err)
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &testTmux{t: t, sock: filepath.Join(base, "tmux.sock")}
	t.Cleanup(func() {
		cmd := exec.Command("tmux", "-S", s.sock, "kill-server")
		cmd.Env = tmuxEnv()
		_ = cmd.Run()
	})
	return s
}

// run is a tmux command from outside the server under test, as a user in
// their own terminal.
func (s *testTmux) run(args ...string) error {
	cmd := exec.Command("tmux", append([]string{"-f", "/dev/null", "-S", s.sock}, args...)...)
	cmd.Env = tmuxEnv()
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux %v: %w: %s", args, err, out)
	}
	return nil
}

func (s *testTmux) must(args ...string) {
	s.t.Helper()
	if err := s.run(args...); err != nil {
		s.t.Fatal(err)
	}
}

// tmuxEnv keeps the token and the caller's tmux out of the test server.
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

// lockedBuffer is a bytes.Buffer safe for the logger and the test at once.
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

// messages returns the msg field of every JSON log line, in order.
func (b *lockedBuffer) messages(t *testing.T) []string {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []string
	for line := range strings.SplitSeq(strings.TrimSpace(b.buf.String()), "\n") {
		var rec struct {
			Msg string `json:"msg"`
		}
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		out = append(out, rec.Msg)
	}
	return out
}

// runAppConfig is a valid standalone configuration on an HTTP unix socket
// in a temp dir, against the tmux server tm.
func runAppConfig(t *testing.T, tm *testTmux) config.Config {
	t.Helper()
	return config.Config{
		Listen:           config.Listen{Network: "unix", Address: filepath.Join(t.TempDir(), "http.sock")},
		AuthToken:        testToken,
		AllowedPaths:     []string{t.TempDir()},
		CORSOrigins:      []string{"https://tmuxde.example"},
		ConfigDir:        t.TempDir(),
		Home:             t.TempDir(),
		IdleTimeout:      config.DefaultIdleTimeout,
		TmuxSocket:       tm.sock,
		TmuxDefaultShell: "/bin/sh",
	}
}

// runningApp is runApp in the background. cancel is the signal. exit gets
// the exit code.
type runningApp struct {
	client *http.Client // dials the HTTP unix socket
	logs   *lockedBuffer
	cancel context.CancelFunc
	exit   chan int
}

// startRunApp runs runApp with cfg and returns once /health answers.
func startRunApp(t *testing.T, cfg config.Config) *runningApp {
	t.Helper()
	logs := &lockedBuffer{}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	exit := make(chan int, 1)
	go func() { exit <- runApp(ctx, cfg, logger, time.Now()) }()

	httpSock := cfg.Listen.Address
	unixClient := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", httpSock)
		},
	}}
	t.Cleanup(unixClient.CloseIdleConnections)
	deadline := time.Now().Add(stopWait)
	for {
		resp, err := unixClient.Get("http://tmuxde/health")
		if err == nil {
			resp.Body.Close()
			break
		}
		select {
		case code := <-exit:
			t.Fatalf("runApp exited %d before it served: %s", code, logs.messages(t))
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("server did not answer: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	return &runningApp{client: unixClient, logs: logs, cancel: cancel, exit: exit}
}

// stop sends the signal and checks that runApp exits with 0.
func (r *runningApp) stop(t *testing.T) {
	t.Helper()
	r.cancel()
	select {
	case code := <-r.exit:
		if code != 0 {
			t.Fatalf("exit %d: %s", code, r.logs.messages(t))
		}
	case <-time.After(stopWait):
		t.Fatal("runApp did not return")
	}
}

// checkOrder fails unless every message in order is logged, in this
// order.
func (r *runningApp) checkOrder(t *testing.T, order ...string) {
	t.Helper()
	msgs := r.logs.messages(t)
	at := -1
	for _, want := range order {
		i := slices.Index(msgs, want)
		if i < 0 || i < at {
			t.Fatalf("log %q, want %q in this order", msgs, order)
		}
		at = i
	}
}

// TestRunAppRunsNode runs standalone mode against a real tmux server: the
// startup sweep, the session monitor and the shutdown order.
func TestRunAppRunsNode(t *testing.T) {
	tm := newTestTmux(t)
	tm.must("new-session", "-d", "-s", "work", "/bin/sh")
	tm.must("new-session", "-d", "-s", "__tmuxde_left", "/bin/sh")

	r := startRunApp(t, runAppConfig(t, tm))
	unixClient := r.client
	if err := tm.run("has-session", "-t", "=__tmuxde_left"); err == nil {
		t.Fatal("the startup sweep left the clone")
	}

	// Not under the run context: the socket must outlive the signal below
	// to see the close.
	wctx, wcancel := context.WithTimeout(context.Background(), 2*stopWait)
	defer wcancel()
	c, _, err := websocket.Dial(wctx, "ws://tmuxde/_relay", &websocket.DialOptions{HTTPClient: unixClient})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	write := func(msg string) {
		t.Helper()
		if err := c.Write(wctx, websocket.MessageText, []byte(msg)); err != nil {
			t.Fatal(err)
		}
	}
	readUntil := func(prefix string) {
		t.Helper()
		for {
			_, data, err := c.Read(wctx)
			if err != nil {
				t.Fatalf("no frame starting %s: %v", prefix, err)
			}
			if strings.HasPrefix(string(data), prefix) {
				return
			}
		}
	}
	write(`{"type":"auth","token":"` + testToken + `"}`)
	// A node reply shows the connection is open on the node, so the
	// monitor broadcast below reaches it.
	write(`{"type":"session:list"}`)
	readUntil(`{"type":"session:list","sessions":[{"name":"work",`)

	// The monitor announces a session made outside the browser on its
	// next session poll, at most five seconds away.
	tm.must("new-session", "-d", "-s", "late", "/bin/sh")
	readUntil(`{"type":"session:created","session":{"name":"late",`)

	// The session list that follows the new session, or any other frame
	// still on its way, is read past until the close.
	errs := make(chan error, 1)
	go func() {
		for {
			if _, _, err := c.Read(wctx); err != nil {
				errs <- err
				return
			}
		}
	}()
	r.stop(t)
	var ce websocket.CloseError
	if err := <-errs; !errors.As(err, &ce) || ce.Code != websocket.StatusGoingAway {
		t.Fatalf("socket ended with %v, want 1001", err)
	}

	// The node starts before the listener and stops after the sockets.
	// Without STT_SOCKET dictation is off, and the log says so. runApp
	// serves the embedded web build and logs whether it is there.
	webLine := "web build missing"
	if web.Present() {
		webLine = "web build embedded"
	}
	r.checkOrder(t, webLine, "tmux found", "session monitor started", "dictation not configured", "listening",
		"shutting down", "session monitor stopped", "stopped")
}

// TestRunAppDictation runs standalone mode with STT_SOCKET set. The probe
// starts before the listener, finds the speech service healthy and the
// browser is offered dictation. The signal stops the probe.
func TestRunAppDictation(t *testing.T) {
	tm := newTestTmux(t)
	tm.must("new-session", "-d", "-s", "work", "/bin/sh")

	// A speech service that only answers its health check.
	sttSock := filepath.Join(t.TempDir(), "stt.sock")
	ln, err := net.Listen("unix", sttSock)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true,"model":"test","sessions":0}`)
	})
	stt := &http.Server{Handler: mux}
	go func() { _ = stt.Serve(ln) }()
	t.Cleanup(func() { stt.Close() })

	cfg := runAppConfig(t, tm)
	cfg.STTSocket = sttSock
	r := startRunApp(t, cfg)

	// The first check runs at once. Its result is logged.
	deadline := time.Now().Add(stopWait)
	for !slices.Contains(r.logs.messages(t), "Speech service availability changed") {
		if time.Now().After(deadline) {
			t.Fatalf("probe never saw the service: %q", r.logs.messages(t))
		}
		time.Sleep(10 * time.Millisecond)
	}

	ctx, cancel := context.WithTimeout(context.Background(), stopWait)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws://tmuxde/_relay", &websocket.DialOptions{HTTPClient: r.client})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"auth","token":"`+testToken+`"}`)); err != nil {
		t.Fatal(err)
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var ok struct {
		Type     string   `json:"type"`
		Features []string `json:"features"`
	}
	if err := json.Unmarshal(data, &ok); err != nil || ok.Type != "auth:success" || !slices.Contains(ok.Features, "dictation") {
		t.Fatalf("welcome %s, want auth:success with dictation (%v)", data, err)
	}

	r.stop(t)
	// The first check runs next to the listener, so only its presence is
	// checked above, not its place.
	r.checkOrder(t, "tmux found", "dictation configured", "listening", "shutting down", "stopped")
}
