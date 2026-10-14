// Package local is the node that runs in the same process as the hub and
// drives tmux, files and repositories on this machine.
//
// It is the Go port of the relay's message-router.ts and the monitor
// wiring of wire-connections.ts. Every message the hub passes on is handled
// here: sessions, windows, panes, scroll and copy mode, command keys, the
// pty attach, the file messages and repo:request. The node also opens
// files for GET /file, as node.FileOpener.
//
// The node never talks to tmux or a pty directly. It goes through the Tmux,
// Attacher and Monitor dependencies. Files and repositories go through the
// file service and the Repo dependency, which share one path guard. New
// wires the real ones from the configuration. Tests pass fakes to
// NewWithDeps and run without tmux.
//
// Lifecycle, as serve runs it:
//
//	n := local.New(cfg, logger)
//	if err := n.Start(ctx); err != nil { /* tmux missing or bad paths: refuse to serve */ }
//	// serve the hub until shutdown, then close every connection
//	n.Stop()
package local

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"sync"

	"tmuxde/internal/config"
	"tmuxde/internal/node"
	"tmuxde/internal/node/files"
	"tmuxde/internal/node/monitor"
	"tmuxde/internal/node/repo"
	"tmuxde/internal/node/tmux"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
)

// Errors from Open and Handle. Match them with errors.Is.
var (
	// ErrAlreadyOpen means Open ran twice for one connection.
	ErrAlreadyOpen = errors.New("local: connection already open")
	// ErrNotOpen means Handle ran for a connection that is not open.
	ErrNotOpen = errors.New("local: connection not open")
	// ErrNotImplemented means the message type has no handler yet.
	ErrNotImplemented = errors.New("not implemented")
	// ErrTmuxNotWired means the node was built without a tmux client.
	ErrTmuxNotWired = errors.New("tmux not wired")
	// ErrFilesNotWired means the node was built without the file service
	// or without the repository service.
	ErrFilesNotWired = errors.New("files not wired")
	// ErrNotForNode means the hub passed a message it keeps to itself,
	// such as auth, ping or dictation.
	ErrNotForNode = errors.New("local: message is not for the node")
	// ErrNoTmux means tmux -V failed at Start. The relay refused to start
	// for the same reason.
	ErrNoTmux = errors.New("tmux is not installed or not found in PATH, install tmux 3.0 or newer")
)

// Node is the local node. It is safe for concurrent use.
type Node struct {
	cfg        config.Config
	tmux       Tmux
	attacher   Attacher
	newMonitor NewMonitor
	files      *files.Service
	repo       Repo
	log        *slog.Logger
	// maxWatchers caps the watchers of one connection.
	maxWatchers int
	// setupErr is why New could not build the path guard. Start returns
	// it, so serve refuses to run without file access rules.
	setupErr error

	mu    sync.Mutex
	conns map[node.ConnID]*conn

	runMu   sync.Mutex
	started bool
	monitor Monitor
	stopRun context.CancelFunc
}

var (
	_ node.Node       = (*Node)(nil)
	_ node.FileOpener = (*Node)(nil)
)

// New returns the local node for this machine. It runs tmux with the
// socket, home folder and default shell of cfg, attaches ptys with
// PtyAttach and builds the session monitor over the same tmux client with
// the default poll intervals. The monitor watches the sessions some
// connection is attached to. A nil logger means slog.Default(). Nothing
// runs until Start.
//
// The file and repository services share one path guard built from
// cfg.AllowedPaths, cfg.Home and cfg.ConfigDir. The guard resolves its
// deny list here, once. When that fails, the node has no file access and
// Start returns the error.
func New(cfg config.Config, logger *slog.Logger) *Node {
	if logger == nil {
		logger = slog.Default()
	}
	tc := tmux.New(tmux.Options{
		Socket: cfg.TmuxSocket,
		// New sessions and windows that name no folder start in home, as
		// on the relay, not in the folder tmuxde was started from.
		Dir:          cfg.Home,
		DefaultShell: cfg.TmuxDefaultShell,
		// A tmux server tmuxde starts must outlive the tmuxde unit.
		Launcher: tmux.Launcher(cfg.TmuxLauncher),
		Logger:   logger,
	})
	var fileSvc *files.Service
	var repoSvc Repo
	guard, err := files.NewGuard(cfg.AllowedPaths, cfg.Home, cfg.ConfigDir)
	if err == nil {
		fileSvc = files.New(guard, files.Options{Logger: logger})
		repoSvc = repo.New(guard, repo.Options{Logger: logger})
	}
	n := NewWithDeps(cfg, Deps{
		Tmux:   tc,
		Attach: PtyAttach,
		NewMonitor: func(h MonitorHooks) Monitor {
			return monitor.New(tc, monitor.Options{
				Watched:           h.Watched,
				OnSessionExit:     h.OnSessionExit,
				OnSessionCreated:  h.OnSessionCreated,
				OnSessionRenamed:  h.OnSessionRenamed,
				OnSessionsChanged: h.OnSessionsChanged,
				OnWindowsChanged:  h.OnWindowsChanged,
				Logger:            logger,
			})
		},
		Files:  fileSvc,
		Repo:   repoSvc,
		Logger: logger,
	})
	if err != nil {
		n.setupErr = fmt.Errorf("local: file access: %w", err)
	}
	return n
}

// NewWithDeps returns a local node for cfg that uses deps. With a zero
// Deps it has no tmux client: every terminal message answers "not
// implemented: <type>", as the stub did, and Start does nothing.
func NewWithDeps(cfg config.Config, deps Deps) *Node {
	n := &Node{
		cfg:         cfg,
		tmux:        deps.Tmux,
		attacher:    deps.Attach,
		newMonitor:  deps.NewMonitor,
		files:       deps.Files,
		repo:        deps.Repo,
		log:         deps.Logger,
		maxWatchers: defaultMaxWatchers,
		conns:       map[node.ConnID]*conn{},
	}
	if n.attacher == nil {
		n.attacher = PtyAttach
	}
	if n.log == nil {
		n.log = slog.Default()
	}
	return n
}

// Start checks that tmux runs, sweeps clone sessions left by an earlier
// run, once, and then starts the session monitor with the node's hooks.
// The monitor runs until Stop or until ctx ends.
//
// A failed tmux -V returns an error that matches ErrNoTmux, and nothing
// else runs. The caller must not serve then. Start can be called again
// after such a failure. Start does nothing without tmux, and a second
// Start after a good one does nothing either. When New could not build the
// path guard, Start returns that error before anything else.
func (n *Node) Start(ctx context.Context) error {
	if n.setupErr != nil {
		return n.setupErr
	}
	n.runMu.Lock()
	defer n.runMu.Unlock()
	if n.started || n.tmux == nil {
		return nil
	}
	// Without the socket flag, as the relay ran it. The socket may not
	// exist yet, and that is fine: the first new session starts the server.
	version, err := n.tmux.Version(ctx)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrNoTmux, err)
	}
	n.log.Info("tmux found", "version", version, "socket", n.cfg.TmuxSocket)
	n.started = true
	// Clones die with their connection, but a crash skips that. The tmux
	// client logs the count.
	n.tmux.SweepOrphanClones(ctx)
	if n.newMonitor == nil {
		return nil
	}
	// The hooks list panes under this context. Stop cancels it.
	runCtx, cancel := context.WithCancel(ctx)
	m := n.newMonitor(MonitorHooks{
		Watched:           n.watched,
		OnSessionExit:     n.sessionExited,
		OnSessionCreated:  n.sessionCreated,
		OnSessionRenamed:  n.followRename,
		OnSessionsChanged: n.sessionsChanged,
		OnWindowsChanged: func(name string, windows []protocol.WindowInfo) {
			n.windowsChanged(runCtx, name, windows)
		},
	})
	if err := m.Start(runCtx); err != nil {
		cancel()
		return fmt.Errorf("local: start session monitor: %w", err)
	}
	n.monitor, n.stopRun = m, cancel
	return nil
}

// Stop stops the session monitor and waits for it. Open connections stay.
func (n *Node) Stop() {
	n.runMu.Lock()
	m, cancel := n.monitor, n.stopRun
	n.monitor, n.stopRun = nil, nil
	n.runMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if m != nil {
		m.Stop()
	}
}

// Open records out as the sink of connection id.
func (n *Node) Open(ctx context.Context, id node.ConnID, out node.Sink) error {
	if out == nil {
		return fmt.Errorf("local: open connection %d: sink is nil", id)
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if _, ok := n.conns[id]; ok {
		return fmt.Errorf("%w: %d", ErrAlreadyOpen, id)
	}
	// The connection lives until Close, whatever happens to the context
	// Open was called with.
	cctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	c := &conn{id: id, sink: out, ctx: cctx, cancel: cancel}
	if n.files != nil {
		c.uploads = n.files.NewUploads()
	}
	n.conns[id] = c
	return nil
}

// Close ends connection id in the relay's removeConnection order: the pty
// first, marked detaching so its end stays silent, then the directory
// watchers, then the temp files of unfinished uploads, then the record.
// The targets of those uploads stay as they were. The tmux session stays
// alive. Closing a connection that is not open does nothing.
func (n *Node) Close(id node.ConnID) {
	n.mu.Lock()
	c, ok := n.conns[id]
	n.mu.Unlock()
	if !ok {
		return
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	a := c.takeLocked()
	watchers := c.takeWatchersLocked()
	c.mu.Unlock()

	if a != nil {
		a.halt()
		a.bridge.MarkDetaching()
	}
	// Ends a pty write that blocks because tmux does not read, and any
	// send that waits for room in the sink. A watcher event waiting there
	// ends too, so the watcher closes below do not wait on the browser.
	c.cancel()
	release(a)
	closeWatchers(watchers)
	if c.uploads != nil {
		c.uploads.Cleanup()
	}

	n.mu.Lock()
	if n.conns[id] == c {
		delete(n.conns, id)
	}
	n.mu.Unlock()
}

// OpenCount reports how many connections are open.
func (n *Node) OpenCount() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.conns)
}

func (n *Node) lookup(id node.ConnID) (*conn, bool) {
	n.mu.Lock()
	c, ok := n.conns[id]
	n.mu.Unlock()
	if !ok || c.isClosed() {
		return nil, false
	}
	return c, true
}

// others returns every open connection but except, in id order. A
// connection that Close has started on is left out. Lock order is n.mu
// before c.mu, never the other way round.
func (n *Node) others(except *conn) []*conn {
	n.mu.Lock()
	defer n.mu.Unlock()
	ids := slices.Sorted(maps.Keys(n.conns))
	list := make([]*conn, 0, len(ids))
	for _, id := range ids {
		if c := n.conns[id]; c != except && !c.isClosed() {
			list = append(list, c)
		}
	}
	return list
}

// Handle routes one client message. Refusals the relay answered with an
// error message go out through the sink as server.Error, and Handle
// returns nil. A returned error is unexpected, and the hub answers it with
// HANDLER_ERROR and the error text.
//
// Handle must not run concurrently for one connection. The hub runs one
// message at a time per connection.
func (n *Node) Handle(ctx context.Context, id node.ConnID, msg client.Message) error {
	c, ok := n.lookup(id)
	if !ok {
		return fmt.Errorf("%w: %d", ErrNotOpen, id)
	}
	if msg == nil {
		return fmt.Errorf("%w: empty message", ErrNotImplemented)
	}
	switch msg.(type) {
	case *client.FileList, *client.FileRead, *client.FileStat, *client.FileWatch,
		*client.FileUnwatch, *client.FileWrite, *client.FileCreate, *client.FileMkdir,
		*client.FileDelete, *client.FileRename, *client.FileUpload:
		if n.files == nil {
			return &notWiredError{wireType: msg.WireType(), missing: ErrFilesNotWired}
		}
		return n.routeFile(ctx, c, msg)
	case *client.Auth, *client.Ping, *client.DictationStart, *client.DictationAudio,
		*client.DictationStop, *client.DictationCancel:
		return fmt.Errorf("%w: %s", ErrNotForNode, msg.WireType())
	}
	if n.tmux == nil {
		return &notWiredError{wireType: msg.WireType(), missing: ErrTmuxNotWired}
	}
	return n.route(ctx, c, msg)
}

// OpenFile opens a regular file read only for GET /file, behind the path
// guard. It is node.FileOpener and returns node.ErrDenied, node.ErrNotFile
// or node.ErrNotFound for the hub to map to a status.
func (n *Node) OpenFile(ctx context.Context, path string) (node.File, error) {
	if n.files == nil {
		return nil, ErrFilesNotWired
	}
	return n.files.Open(ctx, path)
}

// notWiredError reads as the stub's answer, "not implemented: <type>", and
// matches ErrNotImplemented and the missing part, ErrTmuxNotWired or
// ErrFilesNotWired.
type notWiredError struct {
	wireType string
	missing  error
}

func (e *notWiredError) Error() string { return ErrNotImplemented.Error() + ": " + e.wireType }

func (e *notWiredError) Unwrap() []error { return []error{ErrNotImplemented, e.missing} }
