package ws

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/hub/accesslog"
	"tmuxde/internal/hub/conns"
	"tmuxde/internal/hub/dictation"
	"tmuxde/internal/protocol/server"
)

// phase is where a socket is in the auth state machine.
type phase int

const (
	// phaseUnauth waits for the first valid frame. The auth timer runs.
	phaseUnauth phase = iota
	// phaseAuthing checks the first valid frame. The timer is stopped.
	phaseAuthing
	// phaseAuthed routes frames.
	phaseAuthed
	// phaseFailed drops frames until the socket has closed.
	phaseFailed
)

// frame is one item of the outbound queue: an encoded message, or a close
// that runs after everything queued before it is written.
type frame struct {
	data     []byte
	wireType string
	close    *closeFrame
}

type closeFrame struct {
	code   websocket.StatusCode
	reason string
}

// socket is one upgraded WebSocket and its goroutines: the reader, which
// is the ServeHTTP goroutine, the writer and, after auth, the liveness
// ticker.
type socket struct {
	srv  *Server
	ws   *websocket.Conn
	raw  net.Conn
	addr string
	ua   string
	log  *slog.Logger

	// conn is set by run once the registry admits the socket.
	conn    *conns.Conn
	limiter rateLimiter

	out       chan frame
	done      chan struct{} // closed once nothing more can be written
	doneOnce  sync.Once
	closeOnce sync.Once
	// closing is set when the close handshake starts. Writes and pings
	// fail from then on, and that is no reason to drop the socket.
	closing atomic.Bool
	workers sync.WaitGroup // writer and liveness

	mu        sync.Mutex
	phase     phase
	authTimer *time.Timer
	finished  bool

	// dictMu guards the dictation slot. The session is made on the first
	// dictation message. Once the connection is removed the slot is
	// closed and stays empty.
	dictMu     sync.Mutex
	dict       *dictation.Session
	dictClosed bool
}

func newSocket(s *Server, c *websocket.Conn, raw net.Conn, addr, ua string) *socket {
	return &socket{
		srv:     s,
		ws:      c,
		raw:     raw,
		addr:    addr,
		ua:      ua,
		log:     s.log.With("remoteAddr", addr),
		limiter: rateLimiter{limit: s.opts.RateLimit, window: s.opts.RateWindow, start: s.opts.Now()},
		out:     make(chan frame, QueueSize),
		done:    make(chan struct{}),
	}
}

// run admits the socket, serves it until it closes and then runs the
// close path.
func (k *socket) run() {
	c, err := k.srv.reg.Add(k.addr, k.ua, k.registrySend)
	if err != nil {
		reason := reasonServerFull
		if errors.Is(err, conns.ErrAddressFull) {
			reason = reasonAddressFull
		}
		k.log.Warn("rejected connection", "reason", reason)
		k.closeSync(websocket.StatusTryAgainLater, reason)
		return
	}
	k.conn = c
	k.log = k.srv.log.With("conn", c.ID())
	k.log.Debug("connection open", "remoteAddr", c.RemoteAddr())
	c.SetCloser(func(code int, reason string) {
		k.closeAsync(websocket.StatusCode(code), reason)
	})

	k.workers.Add(1)
	go k.writeLoop()
	k.mu.Lock()
	k.authTimer = time.AfterFunc(k.srv.opts.AuthTimeout, k.authTimedOut)
	k.mu.Unlock()

	err = k.readLoop()
	k.finish(err)
}

// readLoop reads frames until the socket fails or closes.
func (k *socket) readLoop() error {
	for {
		_, data, err := k.ws.Read(context.Background())
		if err != nil {
			return err
		}
		k.conn.Touch()
		k.handleFrame(data)
	}
}

// finish is the close path, in the relay's order: stop the timer, mark the
// connection closing, drain its queue, log the disconnect and remove it.
// Removal runs the OnClose hooks, which release the node side.
func (k *socket) finish(readErr error) {
	k.mu.Lock()
	if k.authTimer != nil {
		k.authTimer.Stop()
	}
	k.mu.Unlock()

	// Completes the close handshake, or waits for one already running.
	k.closeSync(websocket.StatusNormalClosure, "")
	k.mu.Lock()
	k.finished = true
	k.mu.Unlock()
	k.stop()
	k.workers.Wait()

	k.conn.SetClosing()
	ctx, cancel := context.WithTimeout(context.Background(), k.srv.opts.DrainTimeout)
	if err := k.conn.Drain(ctx); err != nil {
		k.log.Warn("queued work did not finish before removal", "error", err)
	}
	cancel()

	if k.conn.Authenticated() {
		now := k.srv.opts.Now()
		k.srv.opts.AccessLog.Record(accesslog.Event{
			At:        now,
			Kind:      accesslog.Disconnected,
			Transport: accesslog.Transport(k.conn.RemoteAddr()),
			Seconds:   int(math.Round(now.Sub(k.conn.ConnectedAt()).Seconds())),
		})
	}
	k.srv.reg.Remove(k.conn.ID())
	k.log.Info("connection closed", "code", int(websocket.CloseStatus(readErr)))
}

// writeLoop writes queued frames one at a time until the socket closes.
// A write that takes longer than WriteTimeout drops the socket.
func (k *socket) writeLoop() {
	defer k.workers.Done()
	// Nothing can be written after this returns, so senders must not wait.
	defer k.stop()
	for {
		var f frame
		select {
		case <-k.done:
			return
		case f = <-k.out:
		}
		if f.close != nil {
			k.closeSync(f.close.code, f.close.reason)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), k.srv.opts.WriteTimeout)
		err := k.ws.Write(ctx, websocket.MessageText, f.data)
		cancel()
		if err != nil {
			if !k.closing.Load() {
				k.log.Debug("write failed, dropping socket", "type", f.wireType, "error", err)
				k.terminate()
			}
			return
		}
	}
}

// keepAlive pings every PingInterval. A ping without a pong by the next
// tick drops the socket. Pongs do not count as activity.
func (k *socket) keepAlive() {
	defer k.workers.Done()
	interval := k.srv.opts.PingInterval
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-k.done:
			return
		case <-t.C:
		}
		ctx, cancel := context.WithTimeout(context.Background(), interval)
		err := k.ws.Ping(ctx)
		cancel()
		if err != nil {
			if !k.closing.Load() {
				k.log.Info("no pong, dropping socket", "error", err)
				k.terminate()
			}
			return
		}
	}
}

// send encodes msg and queues it. It blocks while the queue is full and
// returns ctx.Err() when ctx ends first, or ErrClosed once nothing more
// can be written. Encoding here, not in the writer, hands the caller the
// error for a message the browser would reject.
func (k *socket) send(ctx context.Context, msg server.Message) error {
	if msg == nil {
		return errors.New("ws: send nil message")
	}
	data, err := server.Encode(msg)
	if err != nil {
		return fmt.Errorf("ws: encode %s: %w", msg.WireType(), err)
	}
	return k.push(ctx, frame{data: data, wireType: msg.WireType()})
}

func (k *socket) push(ctx context.Context, f frame) error {
	// A closed socket never takes more, even with room in the queue.
	select {
	case <-k.done:
		return ErrClosed
	default:
	}
	select {
	case k.out <- f:
		return nil
	case <-k.done:
		return ErrClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

// registrySend is the send function of the registry. It blocks while the
// queue is full. The writer drains it or drops the socket within
// WriteTimeout, so the wait is bounded.
func (k *socket) registrySend(msg server.Message) error {
	return k.send(context.Background(), msg)
}

// reply sends a hub reply from the reader or a timer. A closed socket is
// not worth a log line.
func (k *socket) reply(msg server.Message) {
	if err := k.send(context.Background(), msg); err != nil && !errors.Is(err, ErrClosed) {
		k.log.Error("reply failed", "type", msg.WireType(), "error", err)
	}
}

// replyThenClose queues msg and then a close, so the browser reads msg
// before the close frame.
func (k *socket) replyThenClose(msg server.Message, code websocket.StatusCode, reason string) {
	k.reply(msg)
	k.queueClose(code, reason)
}

// queueClose queues a close behind everything already queued.
func (k *socket) queueClose(code websocket.StatusCode, reason string) {
	if err := k.push(context.Background(), frame{close: &closeFrame{code, reason}}); err != nil {
		// The socket is closing already.
		k.log.Debug("close not queued", "error", err)
	}
}

// closeSync runs the close handshake once. A second caller waits for the
// first. The handshake ends within a few seconds even when the peer never
// answers.
func (k *socket) closeSync(code websocket.StatusCode, reason string) {
	k.closeOnce.Do(func() {
		k.closing.Store(true)
		// net.ErrClosed means the peer closed first. Nothing failed.
		if err := k.ws.Close(code, reason); err != nil && !errors.Is(err, net.ErrClosed) {
			k.log.Debug("close handshake failed", "error", err)
		}
	})
}

// closeAsync starts the close handshake and returns at once. It is the
// registry closer, so it must not block.
func (k *socket) closeAsync(code websocket.StatusCode, reason string) {
	k.mu.Lock()
	finished := k.finished
	k.mu.Unlock()
	if !finished {
		go k.closeSync(code, reason)
	}
}

// terminate drops the TCP connection without a handshake. Every goroutine
// blocked on the socket returns.
func (k *socket) terminate() {
	if k.raw != nil {
		k.raw.Close()
		return
	}
	go k.ws.CloseNow()
}

// stop ends writing. Queued frames are dropped and blocked senders get
// ErrClosed.
func (k *socket) stop() {
	k.doneOnce.Do(func() { close(k.done) })
}

func (k *socket) getPhase() phase {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.phase
}

func (k *socket) setPhase(p phase) {
	k.mu.Lock()
	k.phase = p
	k.mu.Unlock()
}

// rateLimiter is the relay's fixed window: the window restarts on the
// first frame at least window after the last start. Only the reader uses
// it.
type rateLimiter struct {
	limit  int
	window time.Duration
	count  int
	start  time.Time
}

func (r *rateLimiter) allow(now time.Time) bool {
	if now.Sub(r.start) >= r.window {
		r.count = 0
		r.start = now
	}
	r.count++
	return r.count <= r.limit
}
