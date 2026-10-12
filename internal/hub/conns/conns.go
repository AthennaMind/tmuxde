// Package conns is the registry of browser connections. It is the Go port
// of the relay's connection-manager.ts.
//
// The ws layer drives it:
//
//	c, err := reg.Add(addr, ua, sink) // ErrServerFull or ErrAddressFull: close 1013
//	c.SetCloser(closeSocket)           // must not block
//	c.OnClose(func() { n.Close(node.ConnID(c.Seq())) })
//	c.Touch()                          // every inbound frame
//	c.Authenticate(label)              // after auth, fires OnChanged
//	c.Enqueue(route)                   // every routed message, one at a time
//	c.SetClosing(); c.Drain(ctx); reg.Remove(c.ID()) // on close
//
// The registry never touches a socket. Messages leave through the send
// function given to Add. Closes go through the closer set with SetCloser.
//
// Scoped grants, token revocation and device approval are dropped. Every
// authenticated connection holds the full grant, so a broadcast reaches
// every authenticated connection its predicate selects.
package conns

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"runtime/debug"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"tmuxde/internal/protocol/server"
)

const (
	// MaxConns is the default cap on open connections. Unauthenticated
	// ones count too. Options.MaxConns overrides it.
	MaxConns = 100
	// MaxConnsPerAddr is the default cap on open connections from one
	// remote address. The key is the raw address string. An IPv4 mapped
	// IPv6 address is not folded into its IPv4 form.
	// Options.MaxConnsPerAddr overrides it.
	MaxConnsPerAddr = 10
	// UnknownAddr stands in for an empty remote address. It is counted
	// against the per address cap like any other address.
	UnknownAddr = "unknown"
	// FallbackLabel names an authenticated connection that has no label.
	FallbackLabel = "A device"

	// Disconnect closes with 1000 and a reason. A clean close lets the
	// browser show why it went instead of reconnecting into a loop.
	disconnectCode   = 1000
	disconnectReason = "Closed from the machine"
)

// Errors from Add and Send. Match them with errors.Is.
var (
	// ErrServerFull means the connection cap is reached. The ws layer
	// closes with 1013 "Server at capacity".
	ErrServerFull = errors.New("conns: server at capacity")
	// ErrAddressFull means the address already has the per address cap
	// of open connections. The ws layer closes with 1013 "Too many
	// connections from your address".
	ErrAddressFull = errors.New("conns: too many connections from address")
	// ErrClosed means the connection was removed.
	ErrClosed = errors.New("conns: connection closed")
)

// Options configures New. Zero values pick the defaults.
type Options struct {
	// Logger gets registry records. Default slog.Default().
	Logger *slog.Logger
	// Now is the clock for connect and activity times. Default time.Now.
	Now func() time.Time
	// MaxConns caps open connections. Zero or less means MaxConns.
	MaxConns int
	// MaxConnsPerAddr caps open connections from one address. Zero or
	// less means MaxConnsPerAddr.
	MaxConnsPerAddr int
}

// Registry holds the open connections of one server. It is safe for
// concurrent use. It never holds its lock while it calls out to a send
// function, closer, hook, listener, predicate or builder.
type Registry struct {
	log        *slog.Logger
	now        func() time.Time
	maxConns   int
	maxPerAddr int

	mu        sync.Mutex
	lastSeq   uint64
	conns     map[string]*Conn
	perAddr   map[string]int
	lastSub   uint64
	listeners []listener
}

type listener struct {
	id uint64
	fn func()
}

// Info describes one authenticated connection for a connection list.
type Info struct {
	ID    string
	Label string
	// RemoteAddr is the raw address the connection came from.
	RemoteAddr string
	// AttachedSession is empty while the connection has not attached.
	AttachedSession string
	// ConnectedAt is when the socket was accepted.
	ConnectedAt time.Time
}

// New returns an empty registry.
func New(opts Options) *Registry {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.MaxConns <= 0 {
		opts.MaxConns = MaxConns
	}
	if opts.MaxConnsPerAddr <= 0 {
		opts.MaxConnsPerAddr = MaxConnsPerAddr
	}
	return &Registry{
		log:        opts.Logger,
		now:        opts.Now,
		maxConns:   opts.MaxConns,
		maxPerAddr: opts.MaxConnsPerAddr,
		conns:      map[string]*Conn{},
		perAddr:    map[string]int{},
	}
}

// Add registers a connection that has just been upgraded. It checks the
// global cap first and the per address cap second, as the relay did. A
// refused connection gets no id, so ids stay dense over admitted ones.
//
// Ids are conn-1, conn-2 and so on, per registry, never reused. An empty
// remoteAddr becomes UnknownAddr. send delivers server messages for this
// connection. It must be safe for concurrent use. It may block while the
// socket is slow, but only for a bounded time, because BroadcastWhere waits
// for every send before it returns.
func (r *Registry) Add(remoteAddr, userAgent string, send func(server.Message) error) (*Conn, error) {
	if send == nil {
		return nil, errors.New("conns: send function is nil")
	}
	if remoteAddr == "" {
		remoteAddr = UnknownAddr
	}
	now := r.now()

	r.mu.Lock()
	if len(r.conns) >= r.maxConns {
		r.mu.Unlock()
		return nil, ErrServerFull
	}
	if r.perAddr[remoteAddr] >= r.maxPerAddr {
		r.mu.Unlock()
		return nil, ErrAddressFull
	}
	r.lastSeq++
	ctx, cancel := context.WithCancel(context.Background())
	c := &Conn{
		reg:          r,
		id:           fmt.Sprintf("conn-%d", r.lastSeq),
		seq:          r.lastSeq,
		remoteAddr:   remoteAddr,
		userAgent:    userAgent,
		connectedAt:  now,
		send:         send,
		ctx:          ctx,
		cancel:       cancel,
		lastActivity: now,
	}
	r.conns[c.id] = c
	r.perAddr[remoteAddr]++
	r.mu.Unlock()

	r.log.Debug("connection added", "conn", c.id, "remoteAddr", remoteAddr)
	return c, nil
}

// Get returns the open connection with the given id.
func (r *Registry) Get(id string) (*Conn, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.conns[id]
	return c, ok
}

// Count is the number of open connections, authenticated or not.
func (r *Registry) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.conns)
}

// CountByAddr is the number of open connections from addr. An empty addr
// means UnknownAddr.
func (r *Registry) CountByAddr(addr string) int {
	if addr == "" {
		addr = UnknownAddr
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.perAddr[addr]
}

// All returns every open connection, authenticated or not, in id order.
// The ws layer uses it to close everything on shutdown.
func (r *Registry) All() []*Conn {
	r.mu.Lock()
	list := slices.Collect(maps.Values(r.conns))
	r.mu.Unlock()
	slices.SortFunc(list, func(a, b *Conn) int { return cmp.Compare(a.seq, b.seq) })
	return list
}

// Remove takes a connection out of the registry and reports whether it
// was there. It marks the connection closing, cancels its context, drops
// queued work that has not started, frees its address slot and then runs
// the OnClose hooks in the order they were added. When the connection had
// authenticated, OnChanged listeners fire last.
//
// Remove does not wait for work in flight. Call SetClosing and Drain first
// for that. A second Remove of the same id does nothing and returns false.
// The relay ran its removal twice when a disconnect raced the close event
// and decremented the address count twice.
func (r *Registry) Remove(id string) bool {
	r.mu.Lock()
	c, ok := r.conns[id]
	if !ok {
		r.mu.Unlock()
		return false
	}
	delete(r.conns, id)
	if n := r.perAddr[c.remoteAddr] - 1; n > 0 {
		r.perAddr[c.remoteAddr] = n
	} else {
		delete(r.perAddr, c.remoteAddr)
	}
	r.mu.Unlock()

	c.mu.Lock()
	c.closing = true
	c.removed = true
	hooks := c.onClose
	c.onClose = nil
	clear(c.queue)
	c.queue = nil
	wasAuthenticated := c.authenticated
	c.mu.Unlock()

	c.cancel()
	for _, hook := range hooks {
		r.safely("close hook", c.id, hook)
	}
	r.log.Debug("connection removed", "conn", c.id)
	if wasAuthenticated {
		r.notifyChanged()
	}
	return true
}

// Disconnect closes exactly the connection named by id with 1000 "Closed
// from the machine" and removes it. It reports false when no such
// connection is open. Losing a race against the socket closing on its own
// is ordinary, so that is not an error.
func (r *Registry) Disconnect(id string) bool {
	c, ok := r.Get(id)
	if !ok {
		return false
	}
	c.Close(disconnectCode, disconnectReason)
	return r.Remove(id)
}

// BroadcastWhere sends each selected connection its own message and
// returns how many sends succeeded. It skips unauthenticated connections
// and exclude. A nil pred selects all. build may return a nil message to
// skip a connection.
//
// pred and build run one connection after another, in id order. The sends
// then run in parallel, so a stalled browser does not hold up the others.
// BroadcastWhere returns once every send has ended, so it can take as long
// as the slowest send. Do not hold a lock across it.
//
// A build that fails or panics skips only its own connection. The error is
// logged and the others still get theirs. A failed send is logged too.
func (r *Registry) BroadcastWhere(pred func(*Conn) bool, build func(*Conn) (server.Message, error), exclude *Conn) int {
	type delivery struct {
		c   *Conn
		msg server.Message
	}
	var list []delivery
	for _, c := range r.All() {
		if c == exclude || !c.Authenticated() {
			continue
		}
		msg, err := buildFor(c, pred, build)
		if err != nil {
			r.log.Error("broadcast build failed", "conn", c.id, "error", err)
			continue
		}
		if msg == nil {
			continue
		}
		list = append(list, delivery{c, msg})
	}

	var sent atomic.Int64
	var wg sync.WaitGroup
	for _, d := range list {
		wg.Go(func() {
			if err := d.c.Send(d.msg); err != nil {
				r.log.Debug("broadcast send failed", "conn", d.c.id, "type", d.msg.WireType(), "error", err)
				return
			}
			sent.Add(1)
		})
	}
	wg.Wait()
	return int(sent.Load())
}

// Broadcast sends the same message to every authenticated connection but
// exclude. Use it only for messages every connection may see.
func (r *Registry) Broadcast(msg server.Message, exclude *Conn) int {
	return r.BroadcastWhere(nil, func(*Conn) (server.Message, error) { return msg, nil }, exclude)
}

// buildFor runs pred and build for one connection. A panic in either
// becomes an error.
func buildFor(c *Conn, pred func(*Conn) bool, build func(*Conn) (server.Message, error)) (msg server.Message, err error) {
	defer func() {
		if p := recover(); p != nil {
			msg, err = nil, fmt.Errorf("panic: %v", p)
		}
	}()
	if pred != nil && !pred(c) {
		return nil, nil
	}
	return build(c)
}

// Attached returns the authenticated connections attached to the named
// session, in id order. An empty name matches nothing.
func (r *Registry) Attached(sessionName string) []*Conn {
	if sessionName == "" {
		return nil
	}
	var out []*Conn
	for _, c := range r.All() {
		if c.Authenticated() && c.AttachedSession() == sessionName {
			out = append(out, c)
		}
	}
	return out
}

// AttachedSessions returns the sorted names of the sessions at least one
// authenticated connection is attached to. The session monitor watches
// only these.
func (r *Registry) AttachedSessions() []string {
	seen := map[string]bool{}
	for _, c := range r.All() {
		if name := c.AttachedSession(); name != "" && c.Authenticated() {
			seen[name] = true
		}
	}
	return slices.Sorted(maps.Keys(seen))
}

// Summary lists authenticated connections, oldest first, so a live list
// does not reshuffle on every render. Ties keep id order. A connection
// that opened but never proved anything is not a device the user admitted,
// so it is left out.
func (r *Registry) Summary() []Info {
	out := []Info{}
	for _, c := range r.All() {
		c.mu.Lock()
		if c.authenticated {
			label := c.label
			if label == "" {
				label = FallbackLabel
			}
			out = append(out, Info{
				ID:              c.id,
				Label:           label,
				RemoteAddr:      c.remoteAddr,
				AttachedSession: c.attached,
				ConnectedAt:     c.connectedAt,
			})
		}
		c.mu.Unlock()
	}
	// All is in id order and the sort is stable, so ties keep it.
	slices.SortStableFunc(out, func(a, b Info) int { return a.ConnectedAt.Compare(b.ConnectedAt) })
	return out
}

// IdleCandidates returns the connections, authenticated or not, with no
// inbound activity for longer than timeout at now, in id order. A timeout
// of zero or less disables the reaper and returns nil. The ws layer closes
// each one with 1000 "Idle timeout".
func (r *Registry) IdleCandidates(now time.Time, timeout time.Duration) []*Conn {
	if timeout <= 0 {
		return nil
	}
	var out []*Conn
	for _, c := range r.All() {
		if now.Sub(c.LastActivity()) > timeout {
			out = append(out, c)
		}
	}
	return out
}

// OnChanged subscribes fn to changes in the set of authenticated
// connections. It fires when a connection authenticates and when an
// authenticated one is removed. fn runs in the goroutine that made the
// change, with no lock held, so it may call back into the registry. A
// panicking fn is logged and the other listeners still run. The returned
// function unsubscribes. Calling it again does nothing.
func (r *Registry) OnChanged(fn func()) (unsubscribe func()) {
	r.mu.Lock()
	r.lastSub++
	id := r.lastSub
	r.listeners = append(r.listeners, listener{id: id, fn: fn})
	r.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			r.mu.Lock()
			r.listeners = slices.DeleteFunc(r.listeners, func(l listener) bool { return l.id == id })
			r.mu.Unlock()
		})
	}
}

// notifyChanged calls every listener in subscription order. A broken
// listener must never take a connection down.
func (r *Registry) notifyChanged() {
	r.mu.Lock()
	list := slices.Clone(r.listeners)
	r.mu.Unlock()
	for _, l := range list {
		r.safely("connections listener", "", l.fn)
	}
}

// safely runs fn and logs a panic instead of passing it on.
func (r *Registry) safely(what, connID string, fn func()) {
	defer func() {
		if p := recover(); p != nil {
			r.log.Error(what+" panicked", "conn", connID, "panic", fmt.Sprint(p), "stack", string(debug.Stack()))
		}
	}()
	fn()
}
