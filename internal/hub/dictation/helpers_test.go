package dictation

import (
	"bytes"
	"context"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/protocol/server"
)

// waitLimit bounds every wait in these tests. Nothing should come close.
const waitLimit = 5 * time.Second

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// logBuffer is a goroutine safe log sink.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *logBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *logBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// socketPath is a short unix socket path in a fresh t.TempDir.
func socketPath(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "s")
	if len(p) >= 100 {
		t.Fatalf("socket path is %d bytes, want under 100: %s", len(p), p)
	}
	return p
}

func dialUnix(ctx context.Context, path string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", path)
}

// gatedDial dials path once gate is closed. Until then the dictation is
// connecting. An ended dial context gives up.
func gatedDial(path string, gate <-chan struct{}) func(context.Context) (net.Conn, error) {
	return func(ctx context.Context) (net.Conn, error) {
		select {
		case <-gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return dialUnix(ctx, path)
	}
}

// fakeSTT stands in for the speech service: GET /health and the
// WebSocket on /v1/stream, over a unix socket in t.TempDir.
type fakeSTT struct {
	path       string
	health     atomic.Int32
	healthHits atomic.Int32

	srv    *http.Server
	served chan struct{}

	mu       sync.Mutex
	shut     bool
	sessions []*fakeSession
	changed  chan struct{}
	wg       sync.WaitGroup // stream handlers
}

// fakeOptions script a fake. onSession runs in the handler goroutine
// right after the upgrade. Nil sends ready.
type fakeOptions struct {
	onSession     func(fs *fakeSession)
	health        int
	rejectUpgrade bool
}

func sendReady(fs *fakeSession) { fs.sendText(`{"type":"ready"}`) }

func startFake(t *testing.T, o fakeOptions) *fakeSTT {
	t.Helper()
	if o.onSession == nil {
		o.onSession = sendReady
	}
	if o.health == 0 {
		o.health = http.StatusOK
	}
	f := &fakeSTT{path: socketPath(t), served: make(chan struct{}), changed: make(chan struct{})}
	f.health.Store(int32(o.health))

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		f.healthHits.Add(1)
		w.WriteHeader(int(f.health.Load()))
	})
	mux.HandleFunc("/v1/stream", func(w http.ResponseWriter, r *http.Request) {
		if o.rejectUpgrade {
			http.NotFound(w, r)
			return
		}
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			return
		}
		fs := &fakeSession{conn: c, changed: make(chan struct{}), closeCode: -1}
		if !f.add(fs) {
			c.CloseNow()
			return
		}
		defer f.wg.Done()
		read := make(chan struct{})
		go func() {
			defer close(read)
			fs.readLoop()
		}()
		o.onSession(fs)
		<-read
	})

	ln, err := net.Listen("unix", f.path)
	if err != nil {
		t.Fatal(err)
	}
	f.srv = &http.Server{Handler: mux, ErrorLog: log.New(io.Discard, "", 0)}
	go func() {
		defer close(f.served)
		f.srv.Serve(ln)
	}()
	t.Cleanup(f.stop)
	return f
}

func (f *fakeSTT) add(fs *fakeSession) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.shut {
		return false
	}
	f.wg.Add(1)
	f.sessions = append(f.sessions, fs)
	close(f.changed)
	f.changed = make(chan struct{})
	return true
}

// stop closes the listener, drops every session and waits for the
// handlers. A second call does nothing.
func (f *fakeSTT) stop() {
	f.mu.Lock()
	if f.shut {
		f.mu.Unlock()
		return
	}
	f.shut = true
	sessions := append([]*fakeSession(nil), f.sessions...)
	f.mu.Unlock()
	f.srv.Close()
	<-f.served
	for _, fs := range sessions {
		fs.conn.CloseNow()
	}
	f.wg.Wait()
}

func (f *fakeSTT) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sessions)
}

// session waits for the i-th stream, counting from zero.
func (f *fakeSTT) session(t *testing.T, i int) *fakeSession {
	t.Helper()
	deadline := time.NewTimer(waitLimit)
	defer deadline.Stop()
	for {
		f.mu.Lock()
		if i < len(f.sessions) {
			fs := f.sessions[i]
			f.mu.Unlock()
			return fs
		}
		ch := f.changed
		f.mu.Unlock()
		select {
		case <-ch:
		case <-deadline.C:
			t.Fatalf("speech service never got stream %d", i)
		}
	}
}

// fakeSession is one stream on the fake. It records what the bridge sent.
type fakeSession struct {
	conn *websocket.Conn

	mu        sync.Mutex
	binary    [][]byte
	text      []string
	ended     bool
	closeCode websocket.StatusCode // -1 when no close frame came
	changed   chan struct{}
}

func (fs *fakeSession) readLoop() {
	for {
		typ, data, err := fs.conn.Read(context.Background())
		fs.mu.Lock()
		switch {
		case err != nil:
			fs.ended = true
			fs.closeCode = websocket.CloseStatus(err)
		case typ == websocket.MessageBinary:
			fs.binary = append(fs.binary, data)
		default:
			fs.text = append(fs.text, string(data))
		}
		close(fs.changed)
		fs.changed = make(chan struct{})
		fs.mu.Unlock()
		if err != nil {
			return
		}
	}
}

// waitFor waits until cond holds, checked under fs.mu. It reports false
// when the stream ends first or after waitLimit. Scripts use it.
func (fs *fakeSession) waitFor(cond func() bool) bool {
	deadline := time.NewTimer(waitLimit)
	defer deadline.Stop()
	for {
		fs.mu.Lock()
		if cond() {
			fs.mu.Unlock()
			return true
		}
		if fs.ended {
			fs.mu.Unlock()
			return false
		}
		ch := fs.changed
		fs.mu.Unlock()
		select {
		case <-ch:
		case <-deadline.C:
			return false
		}
	}
}

func (fs *fakeSession) mustWait(t *testing.T, what string, cond func() bool) {
	t.Helper()
	if !fs.waitFor(cond) {
		t.Fatalf("speech service never saw %s", what)
	}
}

// closed waits for the stream to end and returns its close code.
func (fs *fakeSession) closed(t *testing.T) websocket.StatusCode {
	t.Helper()
	fs.mustWait(t, "the stream end", func() bool { return fs.ended })
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.closeCode
}

// frames returns copies of what the bridge sent so far.
func (fs *fakeSession) frames() ([][]byte, []string) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return append([][]byte(nil), fs.binary...), append([]string(nil), fs.text...)
}

func (fs *fakeSession) sendText(s string) {
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	fs.conn.Write(ctx, websocket.MessageText, []byte(s))
}

// recorder stands in for the browser side of one connection. Every
// message must encode, as the ws layer would require.
type recorder struct {
	t       *testing.T
	mu      sync.Mutex
	sent    []server.Message
	changed chan struct{}
}

func newRecorder(t *testing.T) *recorder {
	return &recorder{t: t, changed: make(chan struct{})}
}

func (r *recorder) send(msg server.Message) error {
	if _, err := server.Encode(msg); err != nil {
		r.t.Errorf("bridge sent a message the browser would reject: %v", err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, msg)
	close(r.changed)
	r.changed = make(chan struct{})
	return nil
}

// reply sends what Audio or Stop returned, as the ws layer does.
func (r *recorder) reply(msg server.Message) {
	if msg != nil {
		r.send(msg)
	}
}

func (r *recorder) messages() []server.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]server.Message(nil), r.sent...)
}

// until waits for a message of type typ about dictation id.
func (r *recorder) until(typ, id string) server.Message {
	r.t.Helper()
	deadline := time.NewTimer(waitLimit)
	defer deadline.Stop()
	for {
		r.mu.Lock()
		for _, m := range r.sent {
			if m.WireType() == typ && messageID(m) == id {
				r.mu.Unlock()
				return m
			}
		}
		ch := r.changed
		r.mu.Unlock()
		select {
		case <-ch:
		case <-deadline.C:
			r.t.Fatalf("no %s for %s, got %s", typ, id, describe(r.messages()))
		}
	}
}

func messageID(m server.Message) string {
	switch m := m.(type) {
	case *server.DictationReady:
		return m.ID
	case *server.DictationText:
		return m.ID
	case *server.DictationDone:
		return m.ID
	case *server.DictationError:
		return m.ID
	}
	return ""
}

func describe(msgs []server.Message) string {
	var b bytes.Buffer
	b.WriteString("[")
	for i, m := range msgs {
		if i > 0 {
			b.WriteString(" ")
		}
		data, err := server.Encode(m)
		if err != nil {
			b.WriteString(m.WireType())
			continue
		}
		b.Write(data)
	}
	b.WriteString("]")
	return b.String()
}

// newBridge returns a bridge whose dictation goroutines must all end
// before the test does.
func newBridge(t *testing.T, opts Options) *Bridge {
	t.Helper()
	if opts.Logger == nil {
		opts.Logger = quietLogger()
	}
	b := New(opts)
	t.Cleanup(func() { waitGoroutines(t, b) })
	return b
}

func waitGoroutines(t *testing.T, b *Bridge) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		b.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(waitLimit):
		t.Error("dictation goroutines still running")
	}
}

// newSession returns a session that is closed when the test ends.
func newSession(t *testing.T, b *Bridge) *Session {
	s := b.NewSession()
	t.Cleanup(s.Close)
	return s
}

// running returns the id of the running dictation, or "".
func running(s *Session) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == nil {
		return ""
	}
	return s.cur.id
}

func errorOf(t *testing.T, m server.Message) *server.DictationError {
	t.Helper()
	e, ok := m.(*server.DictationError)
	if !ok {
		t.Fatalf("got %T, want *server.DictationError", m)
	}
	return e
}
