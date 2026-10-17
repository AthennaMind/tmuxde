//go:build integration

package e2e

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/hub/dictation"
	"tmuxde/internal/hub/ws"
	"tmuxde/internal/protocol/server"
)

// stopFrame is the only text the hub sends to the speech service.
const stopFrame = `{"type":"stop"}`

// fakeSTT is the speech service in miniature, over a unix socket in
// t.TempDir: GET /health answers with health, and each WebSocket on
// /v1/stream says ready, collects audio and answers stop with one text
// and done, as stt does.
type fakeSTT struct {
	path       string
	health     atomic.Int32
	healthHits atomic.Int32
	streams    chan *fakeStream

	srv     *http.Server
	served  chan struct{}
	mu      sync.Mutex
	conns   []*websocket.Conn
	handler sync.WaitGroup
}

// fakeStream is one dictation as the service saw it.
type fakeStream struct {
	ended chan struct{} // closed once the connection is gone

	mu        sync.Mutex
	audio     []byte
	texts     []string
	closeCode websocket.StatusCode
}

func newFakeSTT(t *testing.T, health int) *fakeSTT {
	t.Helper()
	path := filepath.Join(t.TempDir(), "stt.sock")
	if len(path) >= 100 {
		t.Fatalf("socket path is %d bytes, want under 100: %s", len(path), path)
	}
	f := &fakeSTT{path: path, streams: make(chan *fakeStream, 8), served: make(chan struct{})}
	f.health.Store(int32(health))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		f.healthHits.Add(1)
		w.WriteHeader(int(f.health.Load()))
	})
	mux.HandleFunc("/v1/stream", f.stream)
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	f.srv = &http.Server{Handler: mux, ErrorLog: log.New(io.Discard, "", 0)}
	go func() {
		defer close(f.served)
		_ = f.srv.Serve(ln)
	}()
	t.Cleanup(f.stop)
	return f
}

func (f *fakeSTT) stream(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	f.mu.Lock()
	f.conns = append(f.conns, c)
	f.handler.Add(1)
	f.mu.Unlock()
	defer f.handler.Done()
	defer c.CloseNow()

	s := &fakeStream{ended: make(chan struct{}), closeCode: -1}
	defer close(s.ended)
	f.streams <- s

	write := func(msg string) error {
		ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
		defer cancel()
		return c.Write(ctx, websocket.MessageText, []byte(msg))
	}
	if write(`{"type":"ready"}`) != nil {
		return
	}
	for {
		typ, data, err := c.Read(context.Background())
		if err != nil {
			s.mu.Lock()
			s.closeCode = websocket.CloseStatus(err)
			s.mu.Unlock()
			return
		}
		s.mu.Lock()
		if typ == websocket.MessageBinary {
			s.audio = append(s.audio, data...)
			s.mu.Unlock()
			continue
		}
		s.texts = append(s.texts, string(data))
		heard := len(s.audio)
		s.mu.Unlock()
		if string(data) != stopFrame {
			continue
		}
		if write(fmt.Sprintf(`{"type":"text","text":"heard %d bytes"}`, heard)) != nil || write(`{"type":"done"}`) != nil {
			return
		}
		c.Close(websocket.StatusNormalClosure, "done")
		return
	}
}

// stop closes the listener, drops every stream and waits for the
// handlers.
func (f *fakeSTT) stop() {
	f.srv.Close()
	<-f.served
	f.mu.Lock()
	conns := slices.Clone(f.conns)
	f.mu.Unlock()
	for _, c := range conns {
		c.CloseNow()
	}
	f.handler.Wait()
}

// next waits for the next stream the hub opens.
func (f *fakeSTT) next(t *testing.T) *fakeStream {
	t.Helper()
	select {
	case s := <-f.streams:
		return s
	case <-time.After(waitLimit):
		t.Fatal("the hub never opened a stream to the speech service")
		return nil
	}
}

// received returns copies of the audio and texts so far.
func (s *fakeStream) received() ([]byte, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.audio), slices.Clone(s.texts)
}

// waitEnded waits until the connection is gone and returns the close
// code the hub sent. It is -1 when no close frame came or when the
// service closed first.
func (s *fakeStream) waitEnded(t *testing.T) websocket.StatusCode {
	t.Helper()
	select {
	case <-s.ended:
	case <-time.After(waitLimit):
		t.Fatal("the speech service connection is still open")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closeCode
}

// eventually polls cond until it holds or waitLimit passes.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitLimit)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("gave up waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// dictationStack is the stack with a bridge to f. Short probe intervals
// let tests see health changes at once.
func dictationStack(t *testing.T, f *fakeSTT) *stack {
	t.Helper()
	return newStackWith(t, stackOptions{dictation: &dictation.Options{
		SocketPath: f.path,
		ProbeUp:    20 * time.Millisecond,
		ProbeDown:  10 * time.Millisecond,
	}})
}

// features returns the features of the auth:success that auth checked.
func (c *client) features() []string {
	c.t.Helper()
	ok, isOK := c.all()[0].(*server.AuthSuccess)
	if !isOK {
		c.t.Fatalf("%s: first message is %s, want auth:success", c.name, c.all()[0].WireType())
	}
	return ok.Features
}

func (c *client) expectDictationError(id, code, text string) {
	c.t.Helper()
	e := expect(c, waitLimit, "dictation:error "+code, func(m *server.DictationError) bool { return m.ID == id })
	if e.Code != code || e.Message != text {
		c.t.Fatalf("%s: dictation:error %s %q, want %s %q", c.name, e.Code, e.Message, code, text)
	}
}

// TestIntegrationDictationFeature checks that browsers are offered dictation once
// the probe sees the service healthy, and not before.
func TestIntegrationDictationFeature(t *testing.T) {
	f := newFakeSTT(t, http.StatusServiceUnavailable)
	s := dictationStack(t, f)

	// A second check means the first answer, 503, was recorded.
	eventually(t, "two health checks", func() bool { return f.healthHits.Load() >= 2 })
	down := s.dial("down")
	down.auth()
	if slices.Contains(down.features(), ws.FeatureDictation) {
		t.Fatalf("offered dictation while the service answers 503: %v", down.features())
	}

	f.health.Store(http.StatusOK)
	eventually(t, "the probe to see the service", s.dictation.Available)
	up := s.dial("up")
	up.auth()
	if !slices.Contains(up.features(), ws.FeatureDictation) {
		t.Fatalf("features %v, want dictation", up.features())
	}
}

// TestIntegrationDictationStream runs one dictation through the hub: ready, audio,
// stop, then text and done in that order.
func TestIntegrationDictationStream(t *testing.T) {
	f := newFakeSTT(t, http.StatusOK)
	s := dictationStack(t, f)
	c := s.dial("mic")
	c.auth()

	c.send(`{"type":"dictation:start","id":"d1"}`)
	expect(c, waitLimit, "dictation:ready", func(m *server.DictationReady) bool { return m.ID == "d1" })
	stream := f.next(t)

	// Unpadded base64 decodes as Node did. AQACAA is 1 0 2 0.
	c.send(`{"type":"dictation:audio","id":"d1","pcm":"AQACAA"}`)
	c.send(`{"type":"dictation:audio","id":"d1","pcm":"` + base64.StdEncoding.EncodeToString([]byte{3, 0, 4, 0, 5, 0}) + `"}`)
	c.send(`{"type":"dictation:stop","id":"d1"}`)

	// expect moves past what it matched, so done must come after text.
	text := expect(c, waitLimit, "dictation:text", func(m *server.DictationText) bool { return m.ID == "d1" })
	if text.Text != "heard 10 bytes" {
		t.Fatalf("text %q, want %q", text.Text, "heard 10 bytes")
	}
	expect(c, waitLimit, "dictation:done", func(m *server.DictationDone) bool { return m.ID == "d1" })

	// The service closes after done, as stt does.
	stream.waitEnded(t)
	audio, texts := stream.received()
	if want := []byte{1, 0, 2, 0, 3, 0, 4, 0, 5, 0}; !bytes.Equal(audio, want) {
		t.Fatalf("service got audio %v, want %v", audio, want)
	}
	if !slices.Equal(texts, []string{stopFrame}) {
		t.Fatalf("service got texts %q, want one stop", texts)
	}

	// The dictation is over. A late stop finds nothing.
	c.send(`{"type":"dictation:stop","id":"d1"}`)
	c.expectDictationError("d1", server.DictationNotFound, "No dictation is running")
}

// TestIntegrationDictationStopWithoutSession checks that stop and audio for a
// dictation that never started answer NOT_FOUND.
func TestIntegrationDictationStopWithoutSession(t *testing.T) {
	f := newFakeSTT(t, http.StatusOK)
	s := dictationStack(t, f)
	c := s.dial("idle")
	c.auth()

	c.send(`{"type":"dictation:stop","id":"d9"}`)
	c.expectDictationError("d9", server.DictationNotFound, "No dictation is running")
	c.send(`{"type":"dictation:audio","id":"d9","pcm":"AAAA"}`)
	c.expectDictationError("d9", server.DictationNotFound, "No dictation is running")
	select {
	case <-f.streams:
		t.Fatal("the hub opened a stream without a start")
	default:
	}
}

// TestIntegrationDictationWithoutService runs the bridge serve builds when
// STT_SOCKET is unset.
func TestIntegrationDictationWithoutService(t *testing.T) {
	s := newStackWith(t, stackOptions{dictation: &dictation.Options{}})
	c := s.dial("nomic")
	c.auth()
	if slices.Contains(c.features(), ws.FeatureDictation) {
		t.Fatalf("offered dictation without a service: %v", c.features())
	}
	c.send(`{"type":"dictation:start","id":"d1"}`)
	c.expectDictationError("d1", server.DictationUnavailable, "Dictation is not enabled on this machine")
	c.send(`{"type":"dictation:stop","id":"d1"}`)
	c.expectDictationError("d1", server.DictationNotFound, "No dictation is running")
}

// TestIntegrationDictationDisconnect checks that a browser that goes away mid
// dictation does not keep its speech service connection.
func TestIntegrationDictationDisconnect(t *testing.T) {
	f := newFakeSTT(t, http.StatusOK)
	s := dictationStack(t, f)
	c := s.dial("tab")
	c.auth()

	c.send(`{"type":"dictation:start","id":"d1"}`)
	expect(c, waitLimit, "dictation:ready", func(m *server.DictationReady) bool { return m.ID == "d1" })
	stream := f.next(t)
	c.send(`{"type":"dictation:audio","id":"d1","pcm":"AQACAA=="}`)
	eventually(t, "the audio to reach the service", func() bool {
		audio, _ := stream.received()
		return len(audio) == 4
	})

	c.conn.Close(websocket.StatusNormalClosure, "")
	if code := stream.waitEnded(t); code != websocket.StatusNormalClosure {
		t.Fatalf("speech service connection closed with %d, want 1000", code)
	}
	if _, texts := stream.received(); len(texts) != 0 {
		t.Fatalf("service got %q after a disconnect, want nothing", texts)
	}
}
