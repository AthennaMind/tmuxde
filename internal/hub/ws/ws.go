// Package ws is the WebSocket lifecycle of the hub on /_relay. It ports
// apps/relay/src/ws-server.ts and wire-connections.ts, plus the dispatch
// frame of message-router.ts.
//
// One connection goes through these steps:
//
//  1. Upgrade. Only on /_relay, only from an allowed Origin, no
//     compression, inbound frames capped at MaxFrame.
//  2. Admission. Over a connection cap the socket closes with 1013 and is
//     never registered.
//  3. Auth. The first valid frame must be auth with the right token, within
//     the auth timeout. A failure sends auth:failure and closes.
//  4. Routing. Every later frame goes through the connection's serial
//     queue. The hub answers ping and a second auth itself. Dictation goes
//     to the connection's session on the speech service bridge.
//     Everything else goes to the node.
//  5. Close. Queued work drains, the access log gets a line and the
//     connection leaves the registry. Its dictation ends, then the node
//     releases it.
//
// Every frame touches the idle clock and counts against the rate limit,
// before and after auth. All messages to the browser, hub replies and node
// messages alike, go through one bounded queue per connection and one
// writer goroutine, so they leave in the order they were queued.
package ws

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/hub/accesslog"
	"tmuxde/internal/hub/auth"
	"tmuxde/internal/hub/conns"
	"tmuxde/internal/hub/dictation"
	"tmuxde/internal/node"
)

// Path is the only path that upgrades.
const Path = "/_relay"

// ServerVersion goes out in auth:success. The relay never bumped it, so
// it says nothing about what a server can do. The features list does.
const ServerVersion = "1.0.0"

// Limits and timeouts. Options can change most of them.
const (
	// MaxFrame caps one inbound message. A bigger one closes with 1009.
	MaxFrame = 1 << 20
	// QueueSize is how many messages wait for one browser before senders
	// block.
	QueueSize = 256

	DefaultAuthTimeout  = 5 * time.Second
	DefaultPingInterval = 30 * time.Second
	DefaultIdleSweep    = 60 * time.Second
	DefaultCloseGrace   = 250 * time.Millisecond
	DefaultWriteTimeout = 30 * time.Second
	DefaultDrainTimeout = 10 * time.Second
	DefaultRateLimit    = 100
	DefaultRateWindow   = time.Second
)

// FeatureDictation is added to the features while dictation is available.
const FeatureDictation = "dictation"

// features are the message types this server understands beyond the
// original protocol. A browser that does not see one falls back to the
// older form.
var features = []string{"repo:request", "repo:history", "file:upload:ack", "window:step", "pane:step"}

// Features returns the auth:success features list.
func Features(dictation bool) []string {
	out := slices.Clone(features)
	if dictation {
		out = append(out, FeatureDictation)
	}
	return out
}

// Codes of the error message sent by the hub.
const (
	CodeRateLimited          = "RATE_LIMITED"
	CodeInvalidMessage       = "INVALID_MESSAGE"
	CodeAlreadyAuthenticated = "ALREADY_AUTHENTICATED"
	CodeHandlerError         = "HANDLER_ERROR"
)

// Close reasons and fixed reply texts. The browser shows some of them.
const (
	reasonServerFull  = "Server at capacity"
	reasonAddressFull = "Too many connections from your address"
	reasonIdle        = "Idle timeout"
	reasonShutdown    = "Server shutting down"
	reasonInternal    = "Internal error"
	reasonAuthTimeout = "Authentication timeout"

	textRateLimited   = "Too many messages"
	textAlreadyAuthed = "This connection is already authenticated."
)

// ErrClosed is returned by a sink once its connection is gone.
var ErrClosed = errors.New("ws: connection closed")

// Options configure New. Token and Node are required. Other zero values
// pick the defaults, except IdleTimeout, where zero disables the reaper.
type Options struct {
	// Token is AUTH_TOKEN.
	Token string
	// Origins are the allowed browser origins, in the form config stores
	// them. An Origin header must match one exactly. Empty allows every
	// origin. A request without Origin is always allowed.
	Origins []string
	// DefaultPath goes out as server:info defaultPath. See DefaultPath.
	DefaultPath string
	// Node gets every message the hub does not answer itself.
	Node node.Node
	// AccessLog records connects and disconnects. Nil records nothing.
	AccessLog *accesslog.Logger
	// Throttle is the per address auth backoff. Nil means a new one.
	Throttle *auth.Throttle
	// Dictation is the speech service bridge. A connection takes a
	// session from it on its first dictation message. Nil means a bridge
	// without a service, so every start answers UNAVAILABLE. The caller
	// runs its probe.
	Dictation *dictation.Bridge
	// DictationAvailable reports whether auth:success offers dictation.
	// It is asked once per login. Nil means Dictation.Available.
	DictationAvailable func() bool
	// Logger gets connection records. Nil means slog.Default().
	Logger *slog.Logger

	// IdleTimeout closes a connection with no inbound frame for this
	// long. Zero or less disables it.
	IdleTimeout time.Duration
	// IdleSweep is how often idle connections are looked for.
	IdleSweep time.Duration
	// AuthTimeout is how long a new connection has to authenticate.
	AuthTimeout time.Duration
	// PingInterval is the liveness tick. A ping without a pong by the next
	// tick drops the connection.
	PingInterval time.Duration
	// CloseGrace is how long Shutdown waits for close handshakes before it
	// drops the sockets.
	CloseGrace time.Duration
	// WriteTimeout bounds one frame write. A browser that takes longer is
	// dropped.
	WriteTimeout time.Duration
	// DrainTimeout bounds how long a closed connection waits for its queued
	// work.
	DrainTimeout time.Duration
	// RateLimit is how many frames one connection may send per RateWindow.
	RateLimit int
	// RateWindow is the fixed rate limit window.
	RateWindow time.Duration
	// MaxConns and MaxConnsPerAddr are the connection caps. Zero means
	// the conns defaults.
	MaxConns        int
	MaxConnsPerAddr int

	// Now is the clock. Nil means time.Now.
	Now func() time.Time
	// Hostname is server:info hostname. Nil means os.Hostname.
	Hostname func() string
	// Uptime is server:info uptime, the system uptime in seconds. Nil
	// means /proc/uptime.
	Uptime func() float64
}

// Server serves /_relay. Create it with New, mount it on Path and call
// Shutdown before the process exits.
type Server struct {
	opts     Options
	log      *slog.Logger
	reg      *conns.Registry
	throttle *auth.Throttle

	mu       sync.Mutex
	closed   bool
	sockets  map[*socket]struct{}
	reaping  bool
	stop     chan struct{}
	handlers sync.WaitGroup // one per upgrade in progress or open socket
	reaper   sync.WaitGroup
}

// New returns a server. It starts nothing until the first request.
func New(opts Options) (*Server, error) {
	if opts.Token == "" {
		return nil, errors.New("ws: token is required")
	}
	if opts.Node == nil {
		return nil, errors.New("ws: node is required")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Throttle == nil {
		opts.Throttle = auth.NewThrottle(opts.Now)
	}
	if opts.Dictation == nil {
		opts.Dictation = dictation.New(dictation.Options{Logger: opts.Logger})
	}
	if opts.DictationAvailable == nil {
		opts.DictationAvailable = opts.Dictation.Available
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Hostname == nil {
		opts.Hostname = hostname
	}
	if opts.Uptime == nil {
		opts.Uptime = systemUptime
	}
	setDefault(&opts.IdleSweep, DefaultIdleSweep)
	setDefault(&opts.AuthTimeout, DefaultAuthTimeout)
	setDefault(&opts.PingInterval, DefaultPingInterval)
	setDefault(&opts.CloseGrace, DefaultCloseGrace)
	setDefault(&opts.WriteTimeout, DefaultWriteTimeout)
	setDefault(&opts.DrainTimeout, DefaultDrainTimeout)
	setDefault(&opts.RateWindow, DefaultRateWindow)
	setDefault(&opts.RateLimit, DefaultRateLimit)
	opts.Origins = slices.Clone(opts.Origins)

	return &Server{
		opts:     opts,
		log:      opts.Logger,
		throttle: opts.Throttle,
		reg: conns.New(conns.Options{
			Logger:          opts.Logger,
			Now:             opts.Now,
			MaxConns:        opts.MaxConns,
			MaxConnsPerAddr: opts.MaxConnsPerAddr,
		}),
		sockets: map[*socket]struct{}{},
		stop:    make(chan struct{}),
	}, nil
}

func setDefault[T time.Duration | int](v *T, def T) {
	if *v <= 0 {
		*v = def
	}
}

// Conns is the registry of open connections.
func (s *Server) Conns() *conns.Registry {
	return s.reg
}

// ServeHTTP upgrades a request for Path. The origin check comes first and
// answers 403 "Forbidden origin" without an upgrade. After Shutdown it
// answers 503. It returns when the connection has ended.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != Path {
		writeText(w, http.StatusNotFound, "Not found")
		return
	}
	if origin := r.Header.Get("Origin"); !s.originAllowed(origin) {
		s.log.Warn("rejected upgrade: origin not allowed", "origin", origin)
		writeText(w, http.StatusForbidden, "Forbidden origin")
		return
	}
	if !s.begin() {
		writeText(w, http.StatusServiceUnavailable, reasonShutdown)
		return
	}
	defer s.handlers.Done()

	hw := &hijackWriter{ResponseWriter: w}
	c, err := websocket.Accept(hw, r, &websocket.AcceptOptions{
		// The origin is checked above, against the configured list only.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		// Accept has answered the request.
		s.log.Debug("upgrade failed", "error", err)
		return
	}
	c.SetReadLimit(MaxFrame)

	k := newSocket(s, c, hw.conn, clientAddr(r), r.UserAgent())
	if !s.track(k) {
		k.closeSync(websocket.StatusGoingAway, reasonShutdown)
		return
	}
	defer s.untrack(k)
	k.run()
}

// originAllowed mirrors isOriginAllowed in ws-server.ts.
func (s *Server) originAllowed(origin string) bool {
	return origin == "" || len(s.opts.Origins) == 0 || slices.Contains(s.opts.Origins, origin)
}

// begin counts a new upgrade and starts the idle reaper on first use. It
// reports false after Shutdown.
func (s *Server) begin() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.handlers.Add(1)
	if !s.reaping && s.opts.IdleTimeout > 0 {
		s.reaping = true
		s.reaper.Add(1)
		go s.reap()
	}
	return true
}

func (s *Server) track(k *socket) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.sockets[k] = struct{}{}
	return true
}

func (s *Server) untrack(k *socket) {
	s.mu.Lock()
	delete(s.sockets, k)
	s.mu.Unlock()
}

func (s *Server) openSockets() []*socket {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Collect(maps.Keys(s.sockets))
}

// reap closes idle connections every IdleSweep until Shutdown.
func (s *Server) reap() {
	defer s.reaper.Done()
	t := time.NewTicker(s.opts.IdleSweep)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
		}
		for _, c := range s.reg.IdleCandidates(s.opts.Now(), s.opts.IdleTimeout) {
			s.log.Info("closing idle connection", "conn", c.ID())
			c.Close(int(websocket.StatusNormalClosure), reasonIdle)
		}
	}
}

// Shutdown refuses new upgrades and closes every socket with 1001 "Server
// shutting down". Sockets still open after CloseGrace are dropped without
// a handshake, so one wedged browser cannot hold the exit. It then waits
// until every connection has finished its close path, or until ctx ends.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		close(s.stop)
	}
	s.mu.Unlock()

	for _, k := range s.openSockets() {
		k.closeAsync(websocket.StatusGoingAway, reasonShutdown)
	}
	done := make(chan struct{})
	go func() {
		s.handlers.Wait()
		s.reaper.Wait()
		close(done)
	}()

	grace := time.NewTimer(s.opts.CloseGrace)
	defer grace.Stop()
	select {
	case <-done:
		return nil
	case <-grace.C:
	case <-ctx.Done():
	}
	for _, k := range s.openSockets() {
		k.terminate()
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// DefaultPath is where the file browser opens: the first allowed path,
// else home, else /. Like path.resolve in the relay, it is absolute and
// clean.
func DefaultPath(allowed []string, home string) string {
	p := "/"
	switch {
	case len(allowed) > 0 && allowed[0] != "":
		p = allowed[0]
	case home != "":
		p = home
	}
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return filepath.Clean(p)
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}

func writeText(w http.ResponseWriter, code int, body string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(code)
	io.WriteString(w, body)
}
