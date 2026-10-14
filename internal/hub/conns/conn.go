package conns

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"tmuxde/internal/protocol/server"
)

// Conn is one browser connection. Its methods are safe for concurrent use.
// The ws layer keeps its own socket state, such as the rate limiter and
// the auth timer, next to it.
type Conn struct {
	reg *Registry

	// Set by Add, never changed.
	id          string
	seq         uint64
	remoteAddr  string
	userAgent   string
	connectedAt time.Time
	send        func(server.Message) error
	// ctx lives as long as the connection. Remove cancels it.
	ctx    context.Context
	cancel context.CancelFunc

	mu            sync.Mutex
	lastActivity  time.Time
	authenticated bool
	label         string
	attached      string
	closer        func(code int, reason string)
	onClose       []func()
	closing       bool
	removed       bool
	// The serial work queue. running is true while a worker goroutine
	// owns the queue. idle is closed when that worker finds it empty.
	queue   []func(context.Context) error
	running bool
	idle    chan struct{}
}

// ID is "conn-N". Disconnect and Remove take it.
func (c *Conn) ID() string { return c.id }

// Seq is the N in the id. The hub passes it to the node as node.ConnID.
func (c *Conn) Seq() uint64 { return c.seq }

// RemoteAddr is the address the caps were keyed on. Never empty.
func (c *Conn) RemoteAddr() string { return c.remoteAddr }

// UserAgent is the User-Agent of the upgrade request, possibly empty.
func (c *Conn) UserAgent() string { return c.userAgent }

// ConnectedAt is when Add accepted the connection.
func (c *Conn) ConnectedAt() time.Time { return c.connectedAt }

// Context is done once the connection is removed. Queued work gets it.
func (c *Conn) Context() context.Context { return c.ctx }

// LogValue logs the connection as its id.
func (c *Conn) LogValue() slog.Value { return slog.StringValue(c.id) }

// LastActivity is the time of the last Touch, or ConnectedAt before any.
func (c *Conn) LastActivity() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastActivity
}

// Touch records inbound activity. The ws layer calls it on every frame,
// also on frames it then drops as rate limited or invalid. Pongs do not
// count. The idle reaper compares against this time.
func (c *Conn) Touch() {
	now := c.reg.now()
	c.mu.Lock()
	c.lastActivity = now
	c.mu.Unlock()
}

// Authenticate marks the connection authenticated with the full grant and
// stores label for the connection list. Choosing the label, with its
// fallback to the user agent description, is the ws layer's job. It then
// fires OnChanged. It reports false and changes nothing when the
// connection is already authenticated or already removed.
func (c *Conn) Authenticate(label string) bool {
	c.mu.Lock()
	if c.authenticated || c.removed {
		c.mu.Unlock()
		return false
	}
	c.authenticated = true
	c.label = label
	c.mu.Unlock()
	c.reg.notifyChanged()
	return true
}

// Authenticated reports whether Authenticate has run.
func (c *Conn) Authenticated() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.authenticated
}

// Label is the label given to Authenticate, possibly empty.
func (c *Conn) Label() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.label
}

// AttachedSession is the name of the tmux session the connection is
// attached to, or empty.
func (c *Conn) AttachedSession() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.attached
}

// SetAttachedSession records the attached session. Empty means detached.
func (c *Conn) SetAttachedSession(name string) {
	c.mu.Lock()
	c.attached = name
	c.mu.Unlock()
}

// SetCloser sets how Close and Disconnect close the socket. closer must
// not block. Start the close handshake in its own goroutine.
func (c *Conn) SetCloser(closer func(code int, reason string)) {
	c.mu.Lock()
	c.closer = closer
	c.mu.Unlock()
}

// Close asks the ws layer to close the socket with code and reason through
// the closer. It does nothing without a closer. It does not remove the
// connection. The ws layer's close path does that, or Disconnect does.
func (c *Conn) Close(code int, reason string) {
	c.mu.Lock()
	closer := c.closer
	c.mu.Unlock()
	if closer != nil {
		c.reg.safely("closer", c.id, func() { closer(code, reason) })
	}
}

// OnClose adds a cleanup hook. Remove runs the hooks once, in the order
// they were added. The ws layer adds dictation before the node, so a
// dictation ends first. A panicking hook is logged and the next one still
// runs. When the connection is already
// removed, fn runs at once in the caller's goroutine, so a hook added
// while a Disconnect races the setup still runs.
func (c *Conn) OnClose(fn func()) {
	c.mu.Lock()
	if !c.removed {
		c.onClose = append(c.onClose, fn)
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	c.reg.safely("close hook", c.id, fn)
}

// SetClosing stops the queue from taking new work. Work already queued
// still runs, so Drain can wait for it. Remove sets it too.
func (c *Conn) SetClosing() {
	c.mu.Lock()
	c.closing = true
	c.mu.Unlock()
}

// Closing reports whether SetClosing or Remove has run.
func (c *Conn) Closing() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closing
}

// Enqueue adds task to the connection's serial queue and reports whether
// it was taken. Tasks run one at a time in the order they were queued, in
// a goroutine the queue starts when it has work and ends when it is
// empty. So two messages from one browser never race each other.
//
// After SetClosing or Remove, Enqueue does nothing and returns false.
// task gets Context, which Remove cancels. An error or a panic from task
// is logged and the next task still runs. The ws layer turns handler
// errors into HANDLER_ERROR inside task itself. The queue is not bounded
// here. The per connection rate limit bounds it.
func (c *Conn) Enqueue(task func(ctx context.Context) error) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closing {
		return false
	}
	c.queue = append(c.queue, task)
	if !c.running {
		c.running = true
		c.idle = make(chan struct{})
		go c.work()
	}
	return true
}

// work runs queued tasks until the queue is empty.
func (c *Conn) work() {
	for {
		c.mu.Lock()
		if len(c.queue) == 0 {
			c.running = false
			close(c.idle)
			c.mu.Unlock()
			return
		}
		task := c.queue[0]
		c.queue[0] = nil
		c.queue = c.queue[1:]
		c.mu.Unlock()
		c.run(task)
	}
}

// run runs one task and logs what goes wrong. An error caused by Remove
// cancelling the context is the expected end of the task, not a failure.
func (c *Conn) run(task func(context.Context) error) {
	defer func() {
		if p := recover(); p != nil {
			c.reg.log.Error("queued task panicked", "conn", c.id, "panic", fmt.Sprint(p), "stack", string(debug.Stack()))
		}
	}()
	err := task(c.ctx)
	switch {
	case err == nil:
	case c.ctx.Err() != nil && errors.Is(err, context.Canceled):
		c.reg.log.Debug("queued task cancelled", "conn", c.id)
	default:
		c.reg.log.Error("queued task failed", "conn", c.id, "error", err)
	}
}

// Drain waits until the queue is empty and no task is running. It returns
// ctx.Err() when ctx ends first. Call SetClosing before it, or new work
// can keep the queue busy. Never call Drain from a queued task. It would
// wait for itself.
func (c *Conn) Drain(ctx context.Context) error {
	c.mu.Lock()
	if !c.running {
		c.mu.Unlock()
		return nil
	}
	idle := c.idle
	c.mu.Unlock()
	select {
	case <-idle:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Send hands msg to the send function given to Add. It returns ErrClosed
// once the connection is removed, and the send function's error otherwise.
func (c *Conn) Send(msg server.Message) error {
	if c.ctx.Err() != nil {
		return ErrClosed
	}
	return c.send(msg)
}
