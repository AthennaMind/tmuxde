// Package edge is the HTTP edge of the hub. It sets the security headers,
// answers /health, OPTIONS and the old code entry redirects, and hands
// every other request to the web app. In development the web app is a
// reverse proxy to the web dev server, WebSocket upgrades for HMR included.
// Otherwise it is the embedded build, passed in as Options.Static.
//
// Other hub packages mount their routes with Edge.Handle before the server
// starts. /_relay, /file and /user belong to them. Until they are mounted
// the edge answers 404 for those paths. /_relay, /file, /user and /health
// never reach the web app.
package edge

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Options configure the edge.
type Options struct {
	// DevWebURL is the web dev server. When set, every request that no
	// route claims goes there. It wins over Static.
	DevWebURL *url.URL
	// Static serves the embedded web build. Used when DevWebURL is nil.
	// Nil means requests that no route claims get 404.
	Static http.Handler
	// Started is the process start time behind the /health uptime. Zero
	// means the time New runs.
	Started time.Time
	// Logger receives dev proxy errors. Nil means slog.Default().
	Logger *slog.Logger
}

// Edge is the root HTTP handler of the hub.
type Edge struct {
	mux *http.ServeMux
	// web serves what no route claims: the dev proxy or Static. Nil when
	// neither is configured.
	web     http.Handler
	started time.Time
}

// codeEntryPaths are upstream code entry routes. The web app has no use for
// them, so they go to the login page.
var codeEntryPaths = []string{"/start", "/pair", "/j"}

// New builds the edge. Mount further routes with Handle before serving.
func New(opts Options) *Edge {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	e := &Edge{mux: http.NewServeMux(), started: opts.Started}
	if e.started.IsZero() {
		e.started = time.Now()
	}
	switch {
	case opts.DevWebURL != nil:
		e.web = newDevProxy(opts.DevWebURL, logger)
	case opts.Static != nil:
		e.web = opts.Static
	}
	e.mux.HandleFunc("/health", e.health)
	for _, p := range codeEntryPaths {
		e.mux.HandleFunc(p, redirectToLogin)
	}
	e.mux.HandleFunc("/", e.fallback)
	return e
}

// Handler builds an edge with no extra routes.
func Handler(opts Options) http.Handler {
	return New(opts)
}

// Handle mounts h on pattern in http.ServeMux syntax, such as "/_relay" or
// "GET /file". Call it before the server starts. A pattern that conflicts
// with one the edge owns panics, as in ServeMux. The security headers are
// already set when h runs. h may replace them.
func (e *Edge) Handle(pattern string, h http.Handler) {
	e.mux.Handle(pattern, h)
}

// ServeHTTP answers OPTIONS on any path, sets the security headers and
// routes the request.
func (e *Edge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Handle preflight before routing. Browser requests use the same origin.
	if r.Method == http.MethodOptions {
		setSecurityHeaders(w.Header(), socketOrigin(r))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// Assets pass through with headers from the web handler.
	if e.web == nil || !isAsset(r.URL.Path) {
		setSecurityHeaders(w.Header(), socketOrigin(r))
	}
	e.mux.ServeHTTP(w, r)
}

// health mirrors the relay: exact URL only, so a query string is a 404.
// Any method works.
func (e *Edge) health(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		notFound(w)
		return
	}
	body, err := json.Marshal(struct {
		Status string  `json:"status"`
		Uptime float64 `json:"uptime"`
	}{"ok", time.Since(e.started).Seconds()})
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

// fallback takes every request no other route claims.
func (e *Edge) fallback(w http.ResponseWriter, r *http.Request) {
	if e.web == nil || isHubPath(r.URL.Path) {
		// Also the answer to an upgrade that is not /_relay. The relay
		// destroyed those sockets. An HTTP answer fails the browser
		// handshake at once instead of leaving it to hang.
		notFound(w)
		return
	}
	e.web.ServeHTTP(w, r)
}

func redirectToLogin(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/login", http.StatusFound)
}

func notFound(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	_, _ = io.WriteString(w, "Not found")
}

// hubPaths are served by the hub only. A request for one of them, or for a
// path below one, never reaches the web app, mounted or not. /user holds
// the user documents below /user/.
var hubPaths = []string{"/_relay", "/file", "/health", "/user"}

func isHubPath(path string) bool {
	for _, p := range hubPaths {
		if path == p || strings.HasPrefix(path, p+"/") {
			return true
		}
	}
	return false
}
