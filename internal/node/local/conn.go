package local

import (
	"context"
	"maps"
	"slices"
	"sync"

	"tmuxde/internal/node"
	"tmuxde/internal/node/files"
	"tmuxde/internal/node/repo"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/server"
)

// conn is the node side of one browser connection.
//
// Handle runs one message at a time per connection. The hub guarantees
// that, as the relay's queue did. The mutex guards the fields below it
// against the output pump, broadcasts from other connections, the monitor
// and Close. It is never held across tmux, pty, file or sink calls.
type conn struct {
	id   node.ConnID
	sink node.Sink
	// ctx lives until Close. Bridges, the pump and watchers run under it.
	ctx    context.Context
	cancel context.CancelFunc
	// uploads holds this connection's unfinished uploads, so two
	// connections never share a partial file. Nil without the file
	// service. Set at Open and safe for concurrent use.
	uploads *files.Uploads

	mu     sync.Mutex
	closed bool
	// gen counts attach state changes. An attachment acts only while its
	// gen is the current one.
	gen uint64
	// att is the live attachment, nil when no pty is attached.
	att *attachment
	// last is the newest attachment whose pump may still run. It outlives
	// att when the pty exits on its own, so the next teardown still waits
	// for the pump to say session:exited first.
	last *attachment
	// attached is the attached session name, "" when none.
	attached string
	// lastSize is the last size given to the pty, nil when unknown.
	lastSize *protocol.TerminalSize
	// activeWindowID is the window the browser was last shown. Kept as
	// the relay kept it. Nothing reads it yet.
	activeWindowID string
	// watchers maps the path of each file:watch, as the browser sent it,
	// to its watcher.
	watchers map[string]*files.Watcher
	// repoWatchers maps the root of each repo:watch to its watch.
	repoWatchers map[string]repo.WatchHandle
}

// attachment is one pty bridge and its output pump.
type attachment struct {
	gen    uint64
	name   string
	bridge Bridge
	// stop is closed when the attachment is torn down. The pump checks it
	// before every send.
	stop     chan struct{}
	stopOnce sync.Once
	// done is closed when the pump has returned.
	done chan struct{}
}

func newAttachment(gen uint64, name string, b Bridge) *attachment {
	return &attachment{
		gen:    gen,
		name:   name,
		bridge: b,
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
	}
}

func (a *attachment) halt() { a.stopOnce.Do(func() { close(a.stop) }) }

func (a *attachment) stopped() bool {
	select {
	case <-a.stop:
		return true
	default:
		return false
	}
}

// release ends an attachment that was taken off its connection: stop the
// pump, mark the pty detaching so its end stays silent, close it and wait
// for the pump. Once release returns, the pump has sent its last message,
// so nothing from this attachment can follow a later reply.
func release(a *attachment) {
	if a == nil {
		return
	}
	a.halt()
	a.bridge.MarkDetaching()
	_ = a.bridge.Close()
	<-a.done
}

// bridge returns the live pty, nil when none is attached.
func (c *conn) bridge() Bridge {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.att == nil {
		return nil
	}
	return c.att.bridge
}

func (c *conn) attachedSession() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.attached
}

func (c *conn) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// takeLocked clears the attach state and returns the attachment to
// release. The caller holds c.mu and calls release after unlocking.
func (c *conn) takeLocked() *attachment {
	a := c.last
	c.att = nil
	c.last = nil
	c.gen++
	c.attached = ""
	c.lastSize = nil
	c.activeWindowID = ""
	return a
}

// detach clears the attach state unconditionally and releases the pty.
func (c *conn) detach() {
	c.mu.Lock()
	a := c.takeLocked()
	c.mu.Unlock()
	release(a)
}

// install makes b the live attachment. It reports false when the
// connection closed meanwhile. The caller then owns b and must close it.
func (c *conn) install(name string, b Bridge, size *protocol.TerminalSize) (*attachment, bool) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, false
	}
	// Normally nil after the teardown at the start of the attach.
	prev := c.last
	c.gen++
	a := newAttachment(c.gen, name, b)
	c.att = a
	c.last = a
	c.attached = name
	c.lastSize = nil
	if size != nil {
		s := *size
		c.lastSize = &s
	}
	c.activeWindowID = ""
	c.mu.Unlock()
	if prev != nil {
		release(prev)
	}
	return a, true
}

// clearIf clears the attach state when a is still the live attachment.
// It keeps c.last, so a later teardown waits for this pump. It returns the
// session name the attachment had at the end, which differs from a.name
// after a rename.
func (c *conn) clearIf(a *attachment) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.att == nil || c.att.gen != a.gen || c.gen != a.gen {
		return "", false
	}
	name := c.attached
	c.att = nil
	c.gen++
	c.attached = ""
	c.lastSize = nil
	c.activeWindowID = ""
	return name, true
}

// renameAttached follows a session rename. The tmux client behind the pty
// stays on the session whatever it is called, so only the name changes.
// It reports whether this connection was attached to oldName.
func (c *conn) renameAttached(oldName, newName string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.attached == "" || c.attached != oldName {
		return false
	}
	c.attached = newName
	return true
}

// resizeTarget returns the bridge to resize, or nil when the size equals
// the last one. ok is false when no pty is attached.
func (c *conn) resizeTarget(size protocol.TerminalSize) (b Bridge, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.att == nil {
		return nil, false
	}
	if c.lastSize != nil && *c.lastSize == size {
		return nil, true
	}
	s := size
	c.lastSize = &s
	return c.att.bridge, true
}

func (c *conn) setActiveWindow(id string) {
	c.mu.Lock()
	c.activeWindowID = id
	c.mu.Unlock()
}

// replaceActiveWindow sets the active window to next when it was killed.
func (c *conn) replaceActiveWindow(killed, next string) {
	c.mu.Lock()
	if c.activeWindowID == killed {
		c.activeWindowID = next
	}
	c.mu.Unlock()
}

// send delivers msgs in order through the sink. It stops at the first
// error.
func (c *conn) send(ctx context.Context, msgs ...server.Message) error {
	for _, m := range msgs {
		if err := c.sink.Send(ctx, m); err != nil {
			return err
		}
	}
	return nil
}

// takeWatchersLocked empties the watcher map and returns its watchers in
// path order. The caller holds c.mu and closes them after unlocking.
func (c *conn) takeWatchersLocked() []*files.Watcher {
	list := make([]*files.Watcher, 0, len(c.watchers))
	for _, p := range slices.Sorted(maps.Keys(c.watchers)) {
		list = append(list, c.watchers[p])
	}
	c.watchers = nil
	return list
}

// takeRepoWatchersLocked empties the repository watch map and returns its
// watches in root order. The caller holds c.mu and closes them after
// unlocking.
func (c *conn) takeRepoWatchersLocked() []repo.WatchHandle {
	list := make([]repo.WatchHandle, 0, len(c.repoWatchers))
	for _, root := range slices.Sorted(maps.Keys(c.repoWatchers)) {
		list = append(list, c.repoWatchers[root])
	}
	c.repoWatchers = nil
	return list
}

// closeRepoWatchers closes each watch and waits for its goroutine.
func closeRepoWatchers(list []repo.WatchHandle) {
	for _, w := range list {
		_ = w.Close()
	}
}

// closeWatchers closes each watcher and waits for its goroutine, so the
// file system handles are released when it returns.
func closeWatchers(list []*files.Watcher) {
	for _, w := range list {
		_ = w.Close()
	}
}
