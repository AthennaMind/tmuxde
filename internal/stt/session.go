package stt

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"time"

	"github.com/coder/websocket"
)

// Message is what the service sends. See "Speech service (internal)" in
// PROTOCOL.md. Type is ready, text, done or error.
type Message struct {
	Type    string `json:"type"`
	Text    string `json:"text,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// SessionLimits bound one dictation.
type SessionLimits struct {
	// MaxSeconds is the audio a session may send. Past it the session
	// stops as if asked to.
	MaxSeconds int
	// Idle closes a session that has sent nothing for this long.
	Idle time.Duration
}

// DefaultIdle is the idle limit of the binary.
const DefaultIdle = 60 * time.Second

// MinPieceSamples is the shortest piece decoded. A piece this short is a
// click or a breath. Parakeet tends to invent a word for it.
const MinPieceSamples = SampleRate / 10

// writeTimeout bounds one message to the hub. A hub that stops reading
// for this long loses the connection.
const writeTimeout = 10 * time.Second

type readResult struct {
	typ  websocket.MessageType
	data []byte
	err  error
}

type decodeResult struct {
	text string
	err  error
	took time.Duration
}

// session is one dictation over one socket. Its state belongs to the
// goroutine of runSession. The reader and each decode run apart and
// report back over channels, so messages go out in order and none
// follows the close.
type session struct {
	conn   *websocket.Conn
	t      Transcriber
	seg    Segmenter
	limits SessionLimits
	log    *slog.Logger

	maxSamples int
	received   int
	decodeTime time.Duration
	stopping   bool
	finished   bool
	outcome    string

	queue    [][]float32 // pieces waiting for a decode, in order
	decoding bool        // one decode runs
	results  chan decodeResult

	idle    *time.Timer
	idleC   <-chan time.Time
	closing chan struct{} // closed once Close returned, nil before finish
}

// runSession runs one dictation until the connection is gone.
//
// Binary messages are audio. The only text message is {"type":"stop"}.
// The segmenter cuts audio into pieces and each one is decoded as soon as
// it is complete, so most of a long dictation is text before the user
// stops. Text goes out in order. After stop the rest is decoded, done goes
// out and the socket closes with 1000. Every error closes it with 1011.
//
// runSession closes seg. ctx ends the session at once: the connection
// closes without a close handshake.
func runSession(ctx context.Context, conn *websocket.Conn, t Transcriber, seg Segmenter, limits SessionLimits, log *slog.Logger) {
	s := &session{
		conn:       conn,
		t:          t,
		seg:        seg,
		limits:     limits,
		log:        log,
		maxSamples: limits.MaxSeconds * SampleRate,
		outcome:    "closed",
		results:    make(chan decodeResult, 1),
		idle:       time.NewTimer(limits.Idle),
	}
	started := time.Now()
	defer seg.Close()
	s.idleC = s.idle.C

	s.send(ctx, Message{Type: "ready"})
	// The loop below takes every result until the read fails, so the
	// reader never blocks for good.
	reads := make(chan readResult)
	go func() {
		for {
			typ, data, err := conn.Read(ctx)
			reads <- readResult{typ, data, err}
			if err != nil {
				return
			}
		}
	}()

loop:
	for {
		select {
		case r := <-reads:
			if r.err != nil {
				break loop
			}
			s.message(ctx, r.typ, r.data)
		case <-s.idleC:
			s.idleC = nil
			s.fail(ctx, "IDLE", "No audio received")
		case res := <-s.results:
			s.decoded(ctx, res)
		}
	}

	s.finished = true
	s.stopping = true
	s.stopIdle()
	if s.closing != nil {
		<-s.closing
	}
	log.Info("Session closed",
		"audioSeconds", int(math.Round(float64(s.received)/SampleRate)),
		"decodeMs", s.decodeTime.Milliseconds(),
		"wallMs", time.Since(started).Milliseconds(),
		"outcome", s.outcome,
	)
}

// message handles one message from the hub.
func (s *session) message(ctx context.Context, typ websocket.MessageType, data []byte) {
	if s.stopping {
		return
	}
	s.touch()
	if typ != websocket.MessageBinary {
		if isStop(data) {
			s.stop(ctx)
		} else {
			s.fail(ctx, "BAD_MESSAGE", "Expected audio or stop")
		}
		return
	}
	samples, err := PCM16ToFloat32(data)
	if err != nil {
		s.fail(ctx, "BAD_AUDIO", "Audio must be 16-bit PCM")
		return
	}
	// Past the cap, keep what fits and stop as if asked to.
	if room := s.maxSamples - s.received; len(samples) > room {
		samples = samples[:room]
	}
	s.received += len(samples)
	for _, piece := range s.seg.Push(samples) {
		s.decode(ctx, piece)
	}
	if s.received >= s.maxSamples {
		s.stop(ctx)
	}
}

// isStop reports whether data is a JSON object with type "stop". Other
// keys are allowed.
func isStop(data []byte) bool {
	var m any
	if json.Unmarshal(data, &m) != nil {
		return false
	}
	obj, ok := m.(map[string]any)
	return ok && obj["type"] == "stop"
}

// decode queues a piece. Pieces too short to be speech are dropped.
func (s *session) decode(ctx context.Context, piece []float32) {
	if len(piece) < MinPieceSamples {
		return
	}
	s.queue = append(s.queue, piece)
	s.pump(ctx)
}

// pump starts the next decode. With nothing left after stop it sends done
// and closes.
func (s *session) pump(ctx context.Context) {
	if s.finished || s.decoding {
		return
	}
	if len(s.queue) == 0 {
		if s.stopping {
			s.send(ctx, Message{Type: "done"})
			s.finish(websocket.StatusNormalClosure, "done")
		}
		return
	}
	piece := s.queue[0]
	s.queue[0] = nil
	s.queue = s.queue[1:]
	s.decoding = true
	// results holds one value and one decode runs at a time, so this
	// goroutine never blocks, even after the session ended.
	go func() {
		begin := time.Now()
		text, err := s.t.Transcribe(piece)
		s.results <- decodeResult{text: text, err: err, took: time.Since(begin)}
	}()
}

// decoded handles the result of one decode.
func (s *session) decoded(ctx context.Context, res decodeResult) {
	s.decoding = false
	s.decodeTime += res.took
	if s.finished {
		return
	}
	if res.err != nil {
		// The error goes to the log only. The hub shows the message
		// to the browser, so it stays generic.
		s.log.Error("Decode failed", "error", res.err.Error())
		s.fail(ctx, "DECODE_FAILED", "Speech could not be transcribed")
		return
	}
	if res.text != "" {
		s.send(ctx, Message{Type: "text", Text: res.text})
	}
	s.pump(ctx)
}

// stop ends the audio: the rest is decoded, then done goes out.
func (s *session) stop(ctx context.Context) {
	if s.stopping {
		return
	}
	s.stopping = true
	s.stopIdle()
	for _, piece := range s.seg.Flush() {
		s.decode(ctx, piece)
	}
	s.pump(ctx)
}

// fail tells the hub what went wrong and closes with 1011.
func (s *session) fail(ctx context.Context, code, message string) {
	if s.finished {
		return
	}
	s.send(ctx, Message{Type: "error", Code: code, Message: message})
	s.finish(websocket.StatusInternalError, code)
}

// finish closes the connection once. The close handshake waits for the
// hub, so it runs apart from the loop, which keeps reading until the
// connection is gone.
func (s *session) finish(code websocket.StatusCode, reason string) {
	if s.finished {
		return
	}
	s.finished = true
	s.stopping = true
	s.outcome = reason
	s.stopIdle()
	s.closing = make(chan struct{})
	go func() {
		defer close(s.closing)
		s.conn.Close(code, reason)
	}()
}

// send writes one message unless the session has finished. A failed
// write closes the connection, and the reader then ends the session.
func (s *session) send(ctx context.Context, m Message) {
	if s.finished {
		return
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(m); err != nil {
		return
	}
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	if err := s.conn.Write(wctx, websocket.MessageText, bytes.TrimSuffix(buf.Bytes(), []byte("\n"))); err != nil {
		s.log.Debug("Write failed", "error", err)
	}
}

func (s *session) touch() {
	s.idle.Reset(s.limits.Idle)
	s.idleC = s.idle.C
}

func (s *session) stopIdle() {
	s.idle.Stop()
	s.idleC = nil
}
