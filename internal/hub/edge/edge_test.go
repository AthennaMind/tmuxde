package edge

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"tmuxde/internal/hub/static"
)

// unusedWebURL is a dev web URL for tests that never reach the proxy.
var unusedWebURL = &url.URL{Scheme: "http", Host: "127.0.0.1:9"}

func quietOptions(opts Options) Options {
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	return opts
}

func record(h http.Handler, method, target string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, nil)
	r.Host = "tmuxde.test"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

// wantSecurityHeaders fails unless h has every edge header, once each.
func wantSecurityHeaders(t *testing.T, h http.Header, socket string) {
	t.Helper()
	want := map[string]string{
		"Content-Security-Policy": contentSecurityPolicy(socket),
		"Permissions-Policy":      "microphone=(self), camera=(), geolocation=()",
		"X-Frame-Options":         "DENY",
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "strict-origin-when-cross-origin",
	}
	for name, value := range want {
		got := h.Values(name)
		if len(got) != 1 || got[0] != value {
			t.Errorf("%s = %q, want [%q]", name, got, value)
		}
	}
}

func wantNoSecurityHeaders(t *testing.T, h http.Header) {
	t.Helper()
	for _, name := range securityHeaders {
		if got := h.Values(name); len(got) != 0 {
			t.Errorf("%s = %q, want none", name, got)
		}
	}
}

func TestHealth(t *testing.T) {
	e := New(quietOptions(Options{Started: time.Now().Add(-90 * time.Second)}))
	for _, method := range []string{"GET", "HEAD", "POST"} {
		t.Run(method, func(t *testing.T) {
			rec := record(e, method, "/health")
			if rec.Code != http.StatusOK {
				t.Fatalf("status %d, want 200", rec.Code)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Fatalf("Content-Type %q", ct)
			}
			wantSecurityHeaders(t, rec.Header(), "ws://tmuxde.test")
			body := rec.Body.String()
			if !strings.HasPrefix(body, `{"status":"ok","uptime":`) {
				t.Fatalf("body %s", body)
			}
			var got map[string]any
			if err := json.Unmarshal([]byte(body), &got); err != nil {
				t.Fatal(err)
			}
			uptime, ok := got["uptime"].(float64)
			if len(got) != 2 || !ok || uptime < 90 || uptime > 3600 {
				t.Fatalf("body %s, want status and uptime of about 90", body)
			}
		})
	}
}

func TestHealthUptimeStartsAtNew(t *testing.T) {
	e := New(quietOptions(Options{}))
	var got struct{ Uptime float64 }
	if err := json.Unmarshal(record(e, "GET", "/health").Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Uptime < 0 || got.Uptime > 60 {
		t.Fatalf("uptime %v, want a few seconds at most", got.Uptime)
	}
}

func TestOptionsAnyPath(t *testing.T) {
	webs := map[string]*url.URL{"no web": nil, "dev web": unusedWebURL}
	paths := []string{"/", "/_relay", "/file?path=/x", "/health", "/login", "/start", "/assets/a.js", "*"}
	for name, web := range webs {
		e := New(quietOptions(Options{DevWebURL: web}))
		t.Run(name, func(t *testing.T) {
			for _, path := range paths {
				t.Run(path, func(t *testing.T) {
					rec := record(e, "OPTIONS", path)
					if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
						t.Fatalf("status %d body %q, want 204 and no body", rec.Code, rec.Body)
					}
					wantSecurityHeaders(t, rec.Header(), "ws://tmuxde.test")
				})
			}
		})
	}
}

func TestCodeEntryRedirects(t *testing.T) {
	e := New(quietOptions(Options{DevWebURL: unusedWebURL}))
	tests := []struct{ method, path string }{
		{"GET", "/start"},
		{"GET", "/pair"},
		{"GET", "/j"},
		{"GET", "/start?code=ABCD"},
		{"POST", "/j"},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			rec := record(e, tt.method, tt.path)
			if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/login" {
				t.Fatalf("status %d Location %q, want 302 to /login", rec.Code, rec.Header().Get("Location"))
			}
			wantSecurityHeaders(t, rec.Header(), "ws://tmuxde.test")
		})
	}
}

func TestNotFoundWithoutWeb(t *testing.T) {
	e := New(quietOptions(Options{}))
	paths := []string{
		"/", "/login", "/s/abc", "/start/x", "/_relay", "/file?path=/etc/passwd",
		"/assets/a.js", "/sw.js", "/health?x=1", "/health?", "/health/",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			rec := record(e, "GET", path)
			if rec.Code != http.StatusNotFound || rec.Body.String() != "Not found" {
				t.Fatalf("status %d body %q, want 404 Not found", rec.Code, rec.Body)
			}
			// Nothing passes through, so even asset paths get headers.
			wantSecurityHeaders(t, rec.Header(), "ws://tmuxde.test")
		})
	}
}

func TestHandleMountsBeforeTheWebApp(t *testing.T) {
	web := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "web")
	})
	mounted := func(name string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, name)
		})
	}
	e := New(quietOptions(Options{Static: web}))
	e.Handle("/_relay", mounted("relay"))
	e.Handle("GET /file", mounted("file"))
	e.Handle("/override", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "sandbox")
	}))

	tests := []struct {
		method, path string
		code         int
		body         string
	}{
		{"GET", "/_relay", 200, "relay"},
		{"GET", "/_relay?token=x", 200, "relay"},
		{"GET", "/file?path=/x", 200, "file"},
		{"HEAD", "/file?path=/x", 200, "file"},
		// The relay answered 404 to anything but GET on /file.
		{"POST", "/file", 404, "Not found"},
		{"GET", "/_relay/x", 404, "Not found"},
		{"GET", "/login", 200, "web"},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			rec := record(e, tt.method, tt.path)
			if rec.Code != tt.code || rec.Body.String() != tt.body {
				t.Fatalf("got %d %q, want %d %q", rec.Code, rec.Body, tt.code, tt.body)
			}
			wantSecurityHeaders(t, rec.Header(), "ws://tmuxde.test")
		})
	}

	t.Run("a route may replace a header", func(t *testing.T) {
		rec := record(e, "GET", "/override")
		if got := rec.Header().Values("Content-Security-Policy"); len(got) != 1 || got[0] != "sandbox" {
			t.Fatalf("Content-Security-Policy = %q", got)
		}
	})
}

func TestStaticGetsAssetExclusions(t *testing.T) {
	static := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "static "+r.URL.Path)
	})
	h := Handler(quietOptions(Options{Static: static}))

	tests := []struct {
		path    string
		headers bool
	}{
		// Pages keep the headers: the app routes and index.html.
		{"/", true},
		{"/index.html", true},
		{"/login", true},
		{"/s/abc", true},
		// Below an asset prefix without a file extension the static
		// handler serves index.html. That is a page too.
		{"/assets/", true},
		{"/fonts/", true},
		{"/fonts/x", true},
		// Assets pass through as the web app sent them.
		{"/assets/app-abc123.js", false},
		{"/fonts/ibm-plex-sans-400.woff2", false},
		{"/sw.js", false},
		{"/manifest.json", false},
		{"/offline.html", false},
		{"/dictation-worklet.js", false},
		{"/icon.svg", false},
		{"/robots.txt", false},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			rec := record(h, "GET", tt.path)
			if rec.Body.String() != "static "+tt.path {
				t.Fatalf("body %q", rec.Body)
			}
			if tt.headers {
				wantSecurityHeaders(t, rec.Header(), "ws://tmuxde.test")
			} else {
				wantNoSecurityHeaders(t, rec.Header())
			}
		})
	}
}

// TestStaticIndexKeepsHeaders runs the real static handler. Every path it
// answers with index.html must get the headers, also below an asset prefix.
// Otherwise a client side route from that document could be framed.
func TestStaticIndexKeepsHeaders(t *testing.T) {
	const page = "<!doctype html><title>app</title>"
	site := fstest.MapFS{
		"index.html":                    {Data: []byte(page)},
		"assets/app-abc123.js":          {Data: []byte("app()")},
		"fonts/ibm-plex-sans-400.woff2": {Data: []byte("font")},
	}
	web := static.Handler(site, static.Options{Logger: slog.New(slog.DiscardHandler)})
	h := Handler(quietOptions(Options{Static: web}))

	for _, p := range []string{"/", "/login", "/assets", "/assets/", "/fonts/", "/fonts/x"} {
		t.Run(p, func(t *testing.T) {
			rec := record(h, "GET", p)
			if rec.Code != http.StatusOK || rec.Body.String() != page {
				t.Fatalf("status %d, body %q, want index.html", rec.Code, rec.Body)
			}
			wantSecurityHeaders(t, rec.Header(), "ws://tmuxde.test")
		})
	}
	for _, p := range []string{"/assets/app-abc123.js", "/fonts/ibm-plex-sans-400.woff2"} {
		t.Run(p, func(t *testing.T) {
			rec := record(h, "GET", p)
			if rec.Code != http.StatusOK || rec.Body.String() == page {
				t.Fatalf("status %d, body %q, want the asset", rec.Code, rec.Body)
			}
			// The static handler sets nosniff itself. The edge adds nothing.
			if got := rec.Header().Values("Content-Security-Policy"); len(got) != 0 {
				t.Fatalf("Content-Security-Policy = %q, want none", got)
			}
		})
	}
}

func TestDevWebURLWinsOverStatic(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "dev")
	}))
	t.Cleanup(upstream.Close)
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	static := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "static")
	})
	h := Handler(quietOptions(Options{DevWebURL: target, Static: static}))
	if body := record(h, "GET", "/login").Body.String(); body != "dev" {
		t.Fatalf("body %q, want dev", body)
	}
}
