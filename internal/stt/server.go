package stt

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// StreamPath is the WebSocket route of one dictation.
const StreamPath = "/v1/stream"

// HealthPath answers the probe of the hub and the container health check.
const HealthPath = "/health"

// maxFrameBytes is the read limit. 250 ms of 16 kHz PCM16 is 8 KB.
// Anything near this is not a frame.
const maxFrameBytes = 256 << 10

// ServerOptions configure NewServer.
type ServerOptions struct {
	Transcriber Transcriber
	// Model is the name /health reports.
	Model string
	// MaxSessions is the number of dictations at once. More are closed
	// with 1013 as busy.
	MaxSessions int
	Limits      SessionLimits
	// NewSegmenter makes a fresh segmenter per session. Nil means fixed
	// 30 s chunks.
	NewSegmenter func() (Segmenter, error)
	// Logger gets one line per session. Nil means slog.Default().
	Logger *slog.Logger
}

// Server is the health check and one WebSocket route.
//
// It has no authentication of its own. The service publishes no port. The
// Go server reaches it over a unix socket in the run directory, and has
// already checked the browser's token, origin and grant before any audio
// reaches it.
type Server struct {
	opts ServerOptions
	log  *slog.Logger
	http *http.Server

	ctx    context.Context // ends every session on Close
	cancel context.CancelFunc

	mu     sync.Mutex
	active int
	closed bool
	wg     sync.WaitGroup // handlers of /v1/stream, added under mu
}

// NewServer returns a server. Serve runs it on a listener.
func NewServer(opts ServerOptions) *Server {
	if opts.NewSegmenter == nil {
		opts.NewSegmenter = func() (Segmenter, error) { return NewChunkSegmenter(), nil }
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{opts: opts, log: opts.Logger, ctx: ctx, cancel: cancel}
	s.http = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	return s
}

// Serve accepts connections on ln until Close. It returns
// http.ErrServerClosed after Close.
func (s *Server) Serve(ln net.Listener) error {
	return s.http.Serve(ln)
}

// Close stops the listener, which removes its socket file, ends every
// session at once and waits for them.
func (s *Server) Close() error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	err := s.http.Close()
	s.cancel()
	s.wg.Wait()
	return err
}

// Sessions returns the number of dictations running.
func (s *Server) Sessions() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active
}

// ServeHTTP answers GET /health and upgrades /v1/stream. Everything else
// is 404. Paths match exactly, query included, as the Node service did.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.RequestURI == StreamPath && isUpgrade(r):
		s.stream(w, r)
	case r.RequestURI == HealthPath && r.Method == http.MethodGet && !isUpgrade(r):
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			OK       bool   `json:"ok"`
			Model    string `json:"model"`
			Sessions int    `json:"sessions"`
		}{true, s.opts.Model, s.Sessions()})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func isUpgrade(r *http.Request) bool {
	for _, v := range r.Header.Values("Upgrade") {
		for _, token := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "websocket") {
				return true
			}
		}
	}
	return false
}

// stream runs one dictation. Over the session cap the WebSocket opens and
// closes at once with 1013, so the hub can tell busy from down.
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		s.log.Debug("WebSocket handshake failed", "error", err)
		return
	}
	conn.SetReadLimit(maxFrameBytes)

	s.mu.Lock()
	busy := s.active >= s.opts.MaxSessions
	if !busy {
		s.active++
	}
	s.mu.Unlock()
	if busy {
		conn.Close(websocket.StatusTryAgainLater, "Busy")
		return
	}
	defer func() {
		s.mu.Lock()
		s.active--
		s.mu.Unlock()
	}()

	seg, err := s.opts.NewSegmenter()
	if err != nil {
		s.log.Error("Segmenter failed", "error", err.Error())
		msg, _ := json.Marshal(Message{Type: "error", Code: "DECODE_FAILED", Message: "Speech could not be transcribed"})
		ctx, cancel := context.WithTimeout(s.ctx, writeTimeout)
		conn.Write(ctx, websocket.MessageText, msg)
		cancel()
		conn.Close(websocket.StatusInternalError, "DECODE_FAILED")
		return
	}
	runSession(s.ctx, conn, s.opts.Transcriber, seg, s.opts.Limits, s.log)
}
