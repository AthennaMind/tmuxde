package dictation

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/protocol/server"
)

// Texts of dictation:error. The browser shows them.
const (
	textNotEnabled   = "Dictation is not enabled on this machine"
	textNotReachable = "Speech service is not reachable"
	textBusy         = "Speech service is busy. Try again shortly."
	textClosed       = "Speech service closed the connection"
	textLost         = "Lost the speech service"
	textNonsense     = "Speech service sent nonsense"
	textTooLong      = "Dictation ran too long"
	textNotFound     = "No dictation is running"
	textOverloaded   = "Speech service is not keeping up"
)

// stopFrame is the only text the bridge sends to the service.
var stopFrame = []byte(`{"type":"stop"}`)

// Session is the dictation slot of one browser connection. The ws layer
// makes one per connection with NewSession, routes the four dictation
// messages to it and calls Close when the connection goes away.
//
// Methods are safe for concurrent use. The ws layer calls them from the
// connection's serial queue, so they come in message order. None of them
// waits for the service.
type Session struct {
	b *Bridge

	// mu guards the session and every stream it started. Messages to the
	// browser go out while it is held, so a dictation's messages keep
	// their order and none follows its end.
	mu     sync.Mutex
	cur    *stream
	closed bool
}

// stream is one dictation and its service connection.
type stream struct {
	id   string
	send func(server.Message) error
	log  *slog.Logger

	// Guarded by Session.mu.
	cancelDial    context.CancelFunc
	conn          *websocket.Conn // set once the handshake is done
	early         [][]byte        // audio that came while connecting
	earlyBytes    int
	queue         []outFrame // frames for the writer, in order
	queued        int        // bytes queued and not yet written
	stopRequested bool
	ended         bool
	timer         *time.Timer
	wake          *sync.Cond // on Session.mu, wakes the writer
}

type outFrame struct {
	typ  websocket.MessageType
	data []byte
}

// NewSession returns an empty dictation slot for one browser connection.
func (b *Bridge) NewSession() *Session {
	return &Session{b: b}
}

// Start opens dictation id on the speech service. A running dictation ends
// first, without a message. Everything about the new one goes out through
// send: dictation:ready, text, done and error. send runs with the session
// lock held, so it must not call back into the Session, and it must return
// promptly once the connection is gone.
//
// Without a socket path Start sends UNAVAILABLE at once and keeps nothing.
// Otherwise it connects in the background, bounded by ConnectTimeout and
// ctx, even while the probe says the service is down. Audio and stop that
// come meanwhile wait for the connection. After Close, Start does nothing.
func (s *Session) Start(ctx context.Context, id string, send func(server.Message) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	if s.cur != nil {
		s.end(s.cur)
	}
	if !s.b.Enabled() {
		s.deliver(send, dictationError(id, server.DictationUnavailable, textNotEnabled))
		return
	}

	dialCtx, cancel := context.WithTimeout(ctx, s.b.opts.ConnectTimeout)
	st := &stream{
		id:         id,
		send:       send,
		log:        s.b.log.With("dictation", id),
		cancelDial: cancel,
	}
	st.wake = sync.NewCond(&s.mu)
	st.timer = time.AfterFunc(s.b.opts.MaxSession, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.fail(st, server.DictationFailed, textTooLong)
	})
	s.cur = st
	s.b.goroutine(func() { s.dial(dialCtx, st) })
}

// Audio forwards one frame of 16-bit PCM to dictation id. It keeps pcm,
// so the caller must not change it afterwards. Empty frames and frames
// after stop are dropped. Audio that piles up past MaxBuffered fails the
// dictation with OVERLOADED through its send.
//
// When dictation id does not run, Audio returns NOT_FOUND for the caller
// to send. Otherwise it returns nil.
func (s *Session) Audio(id string, pcm []byte) server.Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.current(id)
	if st == nil {
		return dictationError(id, server.DictationNotFound, textNotFound)
	}
	if st.stopRequested || len(pcm) == 0 {
		return nil
	}
	if st.conn == nil {
		st.earlyBytes += len(pcm)
		if st.earlyBytes > s.b.opts.MaxBuffered {
			s.fail(st, server.DictationOverloaded, textOverloaded)
			return nil
		}
		st.early = append(st.early, pcm)
		return nil
	}
	// The relay checked ws bufferedAmount before adding the frame.
	if st.queued > s.b.opts.MaxBuffered {
		s.fail(st, server.DictationOverloaded, textOverloaded)
		return nil
	}
	st.push(websocket.MessageBinary, pcm)
	return nil
}

// Stop ends the audio of dictation id. The service answers with the rest
// of the text, then done. A repeated stop does nothing. Only MaxSession
// bounds the wait for done.
//
// When dictation id does not run, Stop returns NOT_FOUND for the caller
// to send. Otherwise it returns nil.
func (s *Session) Stop(id string) server.Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.current(id)
	if st == nil {
		return dictationError(id, server.DictationNotFound, textNotFound)
	}
	if st.stopRequested {
		return nil
	}
	st.stopRequested = true
	if st.conn != nil {
		st.push(websocket.MessageText, stopFrame)
	}
	return nil
}

// Cancel drops dictation id without a word. With anyID set it drops
// whatever runs. A cancel for another id, or with nothing running, is
// ignored.
func (s *Session) Cancel(id string, anyID bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.cur; st != nil && (anyID || st.id == id) {
		s.end(st)
	}
}

// Close ends the running dictation without a word and refuses later
// starts. The ws layer calls it when the connection goes away, so a
// closed tab does not keep a service slot. It does not wait for the
// service connection to close.
func (s *Session) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.cur != nil {
		s.end(s.cur)
	}
}

// current returns the running dictation if it is id, else nil.
func (s *Session) current(id string) *stream {
	if st := s.cur; st != nil && st.id == id && !st.ended {
		return st
	}
	return nil
}

// end finishes st quietly. It is idempotent. The service connection
// closes with 1000, or the dial is abandoned. Queued audio is dropped.
// Call with s.mu held.
func (s *Session) end(st *stream) {
	if st.ended {
		return
	}
	st.ended = true
	st.timer.Stop()
	st.early, st.earlyBytes = nil, 0
	st.queue = nil
	if s.cur == st {
		s.cur = nil
	}
	st.wake.Broadcast()
	if st.conn == nil {
		st.cancelDial()
		return
	}
	conn := st.conn
	s.b.goroutine(func() {
		// The handshake waits up to 10 s for a silent peer, so it runs
		// apart from the caller.
		if err := conn.Close(websocket.StatusNormalClosure, ""); err != nil && !errors.Is(err, net.ErrClosed) {
			st.log.Debug("speech service close failed", "error", err)
		}
	})
}

// fail ends st and tells the browser why. Every error is final. Call with
// s.mu held.
func (s *Session) fail(st *stream, code, text string) {
	if st.ended {
		return
	}
	s.end(st)
	s.deliver(st.send, dictationError(st.id, code, text))
}

// deliver sends msg to the browser. A browser that is gone is not worth
// more than a debug line.
func (s *Session) deliver(send func(server.Message) error, msg server.Message) {
	if err := send(msg); err != nil {
		s.b.log.Debug("dictation message not sent", "type", msg.WireType(), "error", err)
	}
}

// dial connects st to the service. On success it hands the early audio,
// and a stop if one came, to the writer, then starts reader and writer.
func (s *Session) dial(ctx context.Context, st *stream) {
	conn, _, err := websocket.Dial(ctx, streamURL, &websocket.DialOptions{
		HTTPClient:      s.b.streamClient,
		CompressionMode: websocket.CompressionDisabled,
	})
	// A canceled parent means the browser connection went away. Its close
	// hook ends st right after, so the failed dial is not worth a word. A
	// handshake timeout gives DeadlineExceeded and still reports. Checked
	// before cancelDial below, which cancels ctx in every case.
	gone := err != nil && errors.Is(ctx.Err(), context.Canceled)

	s.mu.Lock()
	defer s.mu.Unlock()
	// Ending the dial context leaves an open WebSocket alone.
	st.cancelDial()
	if gone {
		s.end(st)
	}
	if st.ended {
		if conn != nil {
			s.b.goroutine(func() { conn.CloseNow() })
		}
		return
	}
	if err != nil {
		// Refused, missing socket, no upgrade or handshake timeout.
		st.log.Warn("Speech service connection failed", "error", err)
		s.fail(st, server.DictationUnavailable, textNotReachable)
		return
	}
	conn.SetReadLimit(s.b.opts.ReadLimit)
	st.conn = conn
	for _, frame := range st.early {
		st.push(websocket.MessageBinary, frame)
	}
	st.early, st.earlyBytes = nil, 0
	if st.stopRequested {
		st.push(websocket.MessageText, stopFrame)
	}
	s.b.goroutine(func() { s.write(st, conn) })
	s.b.goroutine(func() { s.read(st, conn) })
}

// push queues a frame for the writer. Call with s.mu held.
func (st *stream) push(typ websocket.MessageType, data []byte) {
	st.queue = append(st.queue, outFrame{typ, data})
	st.queued += len(data)
	st.wake.Signal()
}

// write sends queued frames in order until st ends. coder/websocket has
// no bufferedAmount, so queued counts bytes until their write returns.
func (s *Session) write(st *stream, conn *websocket.Conn) {
	for {
		s.mu.Lock()
		for len(st.queue) == 0 && !st.ended {
			st.wake.Wait()
		}
		if st.ended {
			s.mu.Unlock()
			return
		}
		f := st.queue[0]
		st.queue[0] = outFrame{}
		st.queue = st.queue[1:]
		s.mu.Unlock()

		// No deadline. A stalled service fills the queue and fails the
		// dictation, and end's close then unblocks this write.
		err := conn.Write(context.Background(), f.typ, f.data)

		s.mu.Lock()
		st.queued -= len(f.data)
		ended := st.ended
		s.mu.Unlock()
		if err != nil {
			if !ended {
				// The reader sees the connection go and says why.
				st.log.Debug("speech service write failed", "error", err)
				conn.CloseNow()
			}
			return
		}
	}
}

// read handles service messages until the connection goes. Binary
// messages and anything after the end are ignored.
func (s *Session) read(st *stream, conn *websocket.Conn) {
	for {
		typ, data, err := conn.Read(context.Background())
		if err != nil {
			s.lost(st, err)
			return
		}
		if typ == websocket.MessageText {
			s.receive(st, data)
		}
	}
}

// receive maps one service message onto the browser protocol.
func (s *Session) receive(st *stream, data []byte) {
	msg, perr := parseSTT(data, s.b.opts.MaxText)
	s.mu.Lock()
	defer s.mu.Unlock()
	if st.ended {
		return
	}
	if perr != nil {
		st.log.Warn("Unexpected message from speech service", "error", perr)
		s.fail(st, server.DictationFailed, textNonsense)
		return
	}
	switch msg.typ {
	case sttReady:
		s.deliver(st.send, &server.DictationReady{Type: "dictation:ready", ID: st.id})
	case sttText:
		s.deliver(st.send, &server.DictationText{Type: "dictation:text", ID: st.id, Text: msg.text})
	case sttDone:
		s.end(st)
		s.deliver(st.send, &server.DictationDone{Type: "dictation:done", ID: st.id})
	case sttError:
		// The service code stays here. Its message is safe to show.
		s.fail(st, server.DictationFailed, msg.message)
	}
}

// lost reports a connection that went while st still ran. A close frame
// decides by its code. A plain end of stream is a close without a code,
// as Node saw 1006. Anything else lost the service.
func (s *Session) lost(st *stream, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st.ended {
		return
	}
	switch code := websocket.CloseStatus(err); {
	case code == websocket.StatusTryAgainLater:
		s.fail(st, server.DictationBusy, textBusy)
	case code != -1:
		s.fail(st, server.DictationFailed, textClosed)
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, syscall.ECONNRESET):
		s.fail(st, server.DictationFailed, textClosed)
	default:
		st.log.Warn("Speech service connection failed", "error", err)
		s.fail(st, server.DictationFailed, textLost)
	}
}

func dictationError(id, code, text string) *server.DictationError {
	return &server.DictationError{Type: "dictation:error", ID: id, Code: code, Message: text}
}
