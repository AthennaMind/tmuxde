package stt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// waitLimit bounds every wait in these tests.
const waitLimit = 10 * time.Second

// socketPath returns a short socket path in a fresh directory. Linux
// allows 107 bytes, and t.TempDir can be longer.
func socketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "stt-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "stt.sock")
}

// counting names each decode by its sample count, so tests can see the
// chunking.
type counting struct {
	mu    sync.Mutex
	calls []int
}

func (c *counting) Transcribe(samples []float32) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, len(samples))
	return fmt.Sprintf("samples %d", len(samples)), nil
}

func (c *counting) Calls() []int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]int(nil), c.calls...)
}

type transcribeFunc func([]float32) (string, error)

func (f transcribeFunc) Transcribe(samples []float32) (string, error) { return f(samples) }

type startOptions struct {
	maxSessions  int
	maxSeconds   int
	idle         time.Duration
	newSegmenter func() (Segmenter, error)
}

func newTestServer(t *testing.T, tr Transcriber, o startOptions) *Server {
	t.Helper()
	if o.maxSessions == 0 {
		o.maxSessions = 4
	}
	if o.maxSeconds == 0 {
		o.maxSeconds = 600
	}
	if o.idle == 0 {
		o.idle = 5 * time.Second
	}
	srv := NewServer(ServerOptions{
		Transcriber:  tr,
		Model:        "test-model",
		MaxSessions:  o.maxSessions,
		Limits:       SessionLimits{MaxSeconds: o.maxSeconds, Idle: o.idle},
		NewSegmenter: o.newSegmenter,
		Logger:       slog.New(slog.NewJSONHandler(io.Discard, nil)),
	})
	t.Cleanup(func() { srv.Close() })
	return srv
}

// serveOn listens on path and serves srv there.
func serveOn(t *testing.T, srv *Server, path string) error {
	t.Helper()
	ln, err := Listen(path)
	if err != nil {
		return err
	}
	go srv.Serve(ln)
	return nil
}

// start runs a service on a fresh socket and returns the socket path.
func start(t *testing.T, tr Transcriber, o startOptions) string {
	t.Helper()
	path := socketPath(t)
	if err := serveOn(t, newTestServer(t, tr, o), path); err != nil {
		t.Fatal(err)
	}
	return path
}

func unixClient(path string) *http.Client {
	return &http.Client{
		Timeout: waitLimit,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", path)
			},
			DisableKeepAlives: true,
		},
	}
}

type healthBody struct {
	OK       bool   `json:"ok"`
	Model    string `json:"model"`
	Sessions int    `json:"sessions"`
}

// health sends GET /health over the socket.
func health(t *testing.T, path string) (int, healthBody) {
	t.Helper()
	resp, err := unixClient(path).Get("http://stt/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body healthBody
	if resp.StatusCode == http.StatusOK {
		if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
			t.Fatalf("content type %q", ct)
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode, body
}

func dial(path, route string) (*websocket.Conn, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	return websocket.Dial(ctx, "ws://stt"+route, &websocket.DialOptions{HTTPClient: unixClient(path)})
}

// client is one dictation as the hub sees it.
type client struct {
	conn  *websocket.Conn
	ready chan struct{}
	ended chan struct{}

	mu       sync.Mutex
	messages []Message
	code     websocket.StatusCode
}

// openSession opens a dictation and collects everything the service says
// until the connection is gone.
func openSession(t *testing.T, path string) *client {
	t.Helper()
	conn, _, err := dial(path, StreamPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	c := &client{conn: conn, ready: make(chan struct{}), ended: make(chan struct{})}
	go func() {
		defer close(c.ended)
		var once sync.Once
		for {
			typ, data, err := conn.Read(context.Background())
			if err != nil {
				c.mu.Lock()
				c.code = websocket.CloseStatus(err)
				c.mu.Unlock()
				return
			}
			if typ != websocket.MessageText {
				continue
			}
			var m Message
			if err := json.Unmarshal(data, &m); err != nil {
				t.Errorf("not JSON: %q", data)
				continue
			}
			c.mu.Lock()
			c.messages = append(c.messages, m)
			c.mu.Unlock()
			if m.Type == "ready" {
				once.Do(func() { close(c.ready) })
			}
		}
	}()
	return c
}

func (c *client) waitReady(t *testing.T) {
	t.Helper()
	select {
	case <-c.ready:
	case <-c.ended:
		t.Fatal("closed before ready")
	case <-time.After(waitLimit):
		t.Fatal("no ready")
	}
}

// closed waits for the end and returns the close code and every message.
func (c *client) closed(t *testing.T) (websocket.StatusCode, []Message) {
	t.Helper()
	select {
	case <-c.ended:
	case <-time.After(waitLimit):
		t.Fatal("the service never closed the connection")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.code, append([]Message(nil), c.messages...)
}

func (c *client) send(t *testing.T, typ websocket.MessageType, data []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	if err := c.conn.Write(ctx, typ, data); err != nil {
		t.Fatal(err)
	}
}

func (c *client) stop(t *testing.T) {
	t.Helper()
	c.send(t, websocket.MessageText, []byte(`{"type":"stop"}`))
}

func silence(seconds float64) []byte {
	return make([]byte, int(seconds*SampleRate)*2)
}

func last(t *testing.T, messages []Message) Message {
	t.Helper()
	if len(messages) == 0 {
		t.Fatal("no messages")
	}
	return messages[len(messages)-1]
}

func TestHealthReportsTheModel(t *testing.T) {
	path := start(t, &counting{}, startOptions{})
	status, body := health(t, path)
	if status != http.StatusOK || body != (healthBody{OK: true, Model: "test-model", Sessions: 0}) {
		t.Fatalf("got %d %+v", status, body)
	}
}

func TestOtherRoutesAre404(t *testing.T) {
	path := start(t, &counting{}, startOptions{})
	for _, target := range []string{"/", "/health?x=1", "/v1/stream", "/v1/stream/"} {
		resp, err := unixClient(path).Get("http://stt" + target)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s: %d, want 404", target, resp.StatusCode)
		}
	}
	resp, err := unixClient(path).Post("http://stt/health", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("POST /health: %d, want 404", resp.StatusCode)
	}
}

func TestRefusesUpgradesOnAnyOtherPath(t *testing.T) {
	path := start(t, &counting{}, startOptions{})
	_, resp, err := dial(path, "/elsewhere")
	if err == nil {
		t.Fatal("upgrade on /elsewhere succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusNotFound || !strings.Contains(err.Error(), "404") {
		t.Fatalf("err = %v, resp = %v", err, resp)
	}
}

func TestTranscribesAfterStopThenSaysDone(t *testing.T) {
	path := start(t, &counting{}, startOptions{})
	c := openSession(t, path)
	c.waitReady(t)
	c.send(t, websocket.MessageBinary, silence(0.5))
	c.send(t, websocket.MessageBinary, silence(0.5))
	c.stop(t)
	code, messages := c.closed(t)
	if code != websocket.StatusNormalClosure {
		t.Fatalf("close code %d, want 1000", code)
	}
	want := []Message{{Type: "ready"}, {Type: "text", Text: "samples 16000"}, {Type: "done"}}
	if !reflect.DeepEqual(messages, want) {
		t.Fatalf("messages %+v, want %+v", messages, want)
	}
}

func TestStopAllowsExtraKeys(t *testing.T) {
	path := start(t, &counting{}, startOptions{})
	c := openSession(t, path)
	c.waitReady(t)
	c.send(t, websocket.MessageText, []byte(`{"type":"stop","reason":"user"}`))
	if code, messages := c.closed(t); code != websocket.StatusNormalClosure || last(t, messages).Type != "done" {
		t.Fatalf("code %d, messages %+v", code, messages)
	}
}

func TestSkipsATailTooShortToBeSpeech(t *testing.T) {
	tr := &counting{}
	path := start(t, tr, startOptions{})
	c := openSession(t, path)
	c.waitReady(t)
	c.send(t, websocket.MessageBinary, silence(0.05))
	c.stop(t)
	_, messages := c.closed(t)
	if want := []Message{{Type: "ready"}, {Type: "done"}}; !reflect.DeepEqual(messages, want) {
		t.Fatalf("messages %+v, want %+v", messages, want)
	}
	if calls := tr.Calls(); len(calls) != 0 {
		t.Fatalf("decoded %v", calls)
	}
}

func TestDecodesFullChunksWhileAudioArrives(t *testing.T) {
	tr := &counting{}
	path := start(t, tr, startOptions{})
	c := openSession(t, path)
	c.waitReady(t)
	for i := 0; i < 31; i++ {
		c.send(t, websocket.MessageBinary, silence(1))
	}
	c.stop(t)
	_, messages := c.closed(t)
	texts := 0
	for _, m := range messages {
		if m.Type == "text" {
			texts++
		}
	}
	if texts != 2 {
		t.Fatalf("%d texts, want 2: %+v", texts, messages)
	}
	// Two chunks, nothing lost or repeated at the cut.
	calls := tr.Calls()
	total := 0
	for _, n := range calls {
		total += n
	}
	if total != 31*SampleRate || calls[0] > 30*SampleRate {
		t.Fatalf("calls %v", calls)
	}
}

func TestStopsAtTheLengthLimitAndKeepsWhatFits(t *testing.T) {
	tr := &counting{}
	path := start(t, tr, startOptions{maxSeconds: 1})
	c := openSession(t, path)
	c.waitReady(t)
	c.send(t, websocket.MessageBinary, silence(1.5))
	code, messages := c.closed(t)
	if code != websocket.StatusNormalClosure || last(t, messages) != (Message{Type: "done"}) {
		t.Fatalf("code %d, messages %+v", code, messages)
	}
	if calls := tr.Calls(); !reflect.DeepEqual(calls, []int{SampleRate}) {
		t.Fatalf("calls %v, want [16000]", calls)
	}
}

func TestRejectsAudioThatIsNotWholeSamples(t *testing.T) {
	path := start(t, &counting{}, startOptions{})
	c := openSession(t, path)
	c.waitReady(t)
	c.send(t, websocket.MessageBinary, make([]byte, 3))
	code, messages := c.closed(t)
	if code != websocket.StatusInternalError {
		t.Fatalf("close code %d, want 1011", code)
	}
	if m := last(t, messages); m.Type != "error" || m.Code != "BAD_AUDIO" {
		t.Fatalf("last message %+v", m)
	}
}

func TestRejectsTextThatIsNotStop(t *testing.T) {
	for _, text := range []string{`{"type":"start"}`, `null`, `["stop"]`, `"stop"`, `stop`} {
		t.Run(text, func(t *testing.T) {
			path := start(t, &counting{}, startOptions{})
			c := openSession(t, path)
			c.waitReady(t)
			c.send(t, websocket.MessageText, []byte(text))
			code, messages := c.closed(t)
			if m := last(t, messages); code != websocket.StatusInternalError || m.Type != "error" || m.Code != "BAD_MESSAGE" {
				t.Fatalf("code %d, last message %+v", code, m)
			}
		})
	}
}

func TestRejectsAnOversizedFrame(t *testing.T) {
	path := start(t, &counting{}, startOptions{})
	c := openSession(t, path)
	c.waitReady(t)
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	c.conn.Write(ctx, websocket.MessageBinary, make([]byte, maxFrameBytes+2))
	if code, _ := c.closed(t); code != websocket.StatusMessageTooBig {
		t.Fatalf("close code %d, want 1009", code)
	}
}

func TestReportsAFailedDecodeWithoutItsError(t *testing.T) {
	path := start(t, transcribeFunc(func([]float32) (string, error) {
		return "", errors.New("native crash")
	}), startOptions{})
	c := openSession(t, path)
	c.waitReady(t)
	c.send(t, websocket.MessageBinary, silence(1))
	c.stop(t)
	code, messages := c.closed(t)
	if m := last(t, messages); code != websocket.StatusInternalError || m.Type != "error" || m.Code != "DECODE_FAILED" {
		t.Fatalf("code %d, last message %+v", code, m)
	}
	raw, _ := json.Marshal(messages)
	if strings.Contains(string(raw), "native crash") {
		t.Fatalf("error text leaked: %s", raw)
	}
}

func TestClosesASessionThatGoesQuiet(t *testing.T) {
	path := start(t, &counting{}, startOptions{idle: 50 * time.Millisecond})
	c := openSession(t, path)
	c.waitReady(t)
	code, messages := c.closed(t)
	if m := last(t, messages); code != websocket.StatusInternalError || m.Type != "error" || m.Code != "IDLE" {
		t.Fatalf("code %d, last message %+v", code, m)
	}
}

func TestIdleLimitStopsAfterStop(t *testing.T) {
	// A slow last decode must not trip the idle limit.
	release := make(chan struct{})
	path := start(t, transcribeFunc(func(samples []float32) (string, error) {
		<-release
		return "late", nil
	}), startOptions{idle: 50 * time.Millisecond})
	c := openSession(t, path)
	c.waitReady(t)
	c.send(t, websocket.MessageBinary, silence(1))
	c.stop(t)
	time.Sleep(150 * time.Millisecond)
	close(release)
	code, messages := c.closed(t)
	want := []Message{{Type: "ready"}, {Type: "text", Text: "late"}, {Type: "done"}}
	if code != websocket.StatusNormalClosure || !reflect.DeepEqual(messages, want) {
		t.Fatalf("code %d, messages %+v", code, messages)
	}
}

func TestTurnsAwaySessionsOverTheLimit(t *testing.T) {
	path := start(t, &counting{}, startOptions{maxSessions: 1})
	first := openSession(t, path)
	first.waitReady(t)
	if _, body := health(t, path); body.Sessions != 1 {
		t.Fatalf("sessions %d, want 1", body.Sessions)
	}
	second := openSession(t, path)
	if code, messages := second.closed(t); code != websocket.StatusTryAgainLater || len(messages) != 0 {
		t.Fatalf("code %d, messages %+v", code, messages)
	}
	first.conn.Close(websocket.StatusNormalClosure, "")
	first.closed(t)
	deadline := time.Now().Add(waitLimit)
	for {
		if _, body := health(t, path); body.Sessions == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("session count never dropped")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestSegmenterFailureFailsTheSession(t *testing.T) {
	path := start(t, &counting{}, startOptions{newSegmenter: func() (Segmenter, error) {
		return nil, errors.New("no detector")
	}})
	c := openSession(t, path)
	code, messages := c.closed(t)
	if code != websocket.StatusInternalError || len(messages) != 1 || messages[0].Code != "DECODE_FAILED" {
		t.Fatalf("code %d, messages %+v", code, messages)
	}
	if strings.Contains(messages[0].Message, "no detector") {
		t.Fatal("error text leaked")
	}
}

// closingSegmenter records Close.
type closingSegmenter struct {
	Segmenter
	closed chan struct{}
}

func (s *closingSegmenter) Close() { close(s.closed) }

func TestSessionClosesItsSegmenter(t *testing.T) {
	seg := &closingSegmenter{Segmenter: NewChunkSegmenter(), closed: make(chan struct{})}
	path := start(t, &counting{}, startOptions{newSegmenter: func() (Segmenter, error) { return seg, nil }})
	c := openSession(t, path)
	c.waitReady(t)
	c.stop(t)
	c.closed(t)
	select {
	case <-seg.closed:
	case <-time.After(waitLimit):
		t.Fatal("segmenter never closed")
	}
}

func TestCloseEndsSessionsAndRemovesTheSocket(t *testing.T) {
	path := socketPath(t)
	srv := newTestServer(t, &counting{}, startOptions{})
	if err := serveOn(t, srv, path); err != nil {
		t.Fatal(err)
	}
	c := openSession(t, path)
	c.waitReady(t)
	done := make(chan struct{})
	go func() {
		srv.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close took more than 2 s")
	}
	c.closed(t)
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket still there: %v", err)
	}
}
