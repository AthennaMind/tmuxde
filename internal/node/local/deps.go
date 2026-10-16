package local

import (
	"context"
	"log/slog"

	"tmuxde/internal/node/files"
	"tmuxde/internal/node/monitor"
	"tmuxde/internal/node/pty"
	"tmuxde/internal/node/repo"
	"tmuxde/internal/node/tmux"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// Tmux is the part of *tmux.Client the router uses. Names and signatures
// match package tmux, so the real client satisfies it as is. Tests pass a
// fake.
type Tmux interface {
	SearchHistory(ctx context.Context, query string, caseSensitive bool, exclude []string) (tmux.SearchResult, error)
	// Version runs tmux -V. Start uses it to check that tmux runs at all.
	Version(ctx context.Context) (string, error)
	// NoStartFlag reports whether tmux takes -N. attach passes it on as
	// pty.Options.NoStart.
	NoStartFlag(ctx context.Context) bool

	ListSessions(ctx context.Context) ([]protocol.SessionInfo, error)
	CreateSession(ctx context.Context, name, cwd, command string) (protocol.SessionInfo, error)
	KillSession(ctx context.Context, name string) error
	RenameSession(ctx context.Context, oldName, newName string) error
	SessionExists(ctx context.Context, name string) bool

	ListWindows(ctx context.Context, session string) ([]protocol.WindowInfo, error)
	StepWindow(ctx context.Context, session string, delta int) error
	CreateWindow(ctx context.Context, session, name string) error
	SelectWindow(ctx context.Context, windowID string) error
	KillWindow(ctx context.Context, windowID string) error
	RenameWindow(ctx context.Context, windowID, name string) error
	SelectLayout(ctx context.Context, session, preset string) error
	RotateLayout(ctx context.Context, session string) error

	ListPanes(ctx context.Context, session, windowID string) ([]protocol.PaneInfo, error)
	CurrentWindowPanes(ctx context.Context, session string) (windowID string, panes []protocol.PaneInfo, err error)
	SplitPane(ctx context.Context, session, direction string) error
	SelectPane(ctx context.Context, session, paneID string) error
	StepPane(ctx context.Context, session string, delta int) error
	ZoomPane(ctx context.Context, session, paneID string, desired *bool) error
	ResizePane(ctx context.Context, paneID, direction string, amount int) error
	KillPane(ctx context.Context, paneID string) error
	SwapPane(ctx context.Context, paneID, direction string) error
	SwapPanes(ctx context.Context, paneID, targetID string) error
	JoinPane(ctx context.Context, paneID, windowID, direction string) error
	BreakPane(ctx context.Context, session, paneID string) error

	PreviewScreens(ctx context.Context, targets []protocol.PreviewTarget, exclude []string) []protocol.PreviewFrame
	CapturePane(ctx context.Context, session string, opts tmux.CaptureOptions) (string, error)
	CapturePaneByID(ctx context.Context, paneID string, opts tmux.CaptureOptions) (string, error)

	SendPrefix(ctx context.Context, session string) error
	SendInterrupt(ctx context.Context, session string) error
	EnterCopyMode(ctx context.Context, session string) error
	ExitCopyMode(ctx context.Context, session string) error
	ReadScrollState(ctx context.Context, session string) (tmux.ScrollState, error)
	ScrollHistory(ctx context.Context, session string, lines int) (tmux.ScrollState, error)
	ScrollToPosition(ctx context.Context, session string, position int) (tmux.ScrollState, error)

	SweepOrphanClones(ctx context.Context) int
}

// Bridge is the part of *pty.Bridge the router uses. See package pty for
// the meaning of each method.
type Bridge interface {
	Session() string
	Output() <-chan string
	Ready() <-chan struct{}
	Done() <-chan struct{}
	Wait() pty.Result
	WriteString(s string) (int, error)
	Resize(cols, rows int) error
	MarkDetaching()
	Close() error
}

// Repo answers repo:request from a pane directory and runs repository
// watches. *repo.Service satisfies it. The result of Request is never nil,
// and failures come back as kind error.
type Repo interface {
	Request(ctx context.Context, cwd string, req *client.RepoRequest) *server.RepoResult
	// WatchRoot finds the repository root a watch from pane folder cwd
	// covers. path is the captured context folder, when the browser sent
	// one.
	WatchRoot(ctx context.Context, cwd string, path *string) (string, error)
	// Watch starts a watch of root. repo:changed, and repo:watch:result
	// when the watch turns partial later, go to send until Close or until
	// ctx ends.
	Watch(ctx context.Context, root string, send func(server.Message)) (repo.WatchHandle, error)
}

var (
	_ Tmux   = (*tmux.Client)(nil)
	_ Bridge = (*pty.Bridge)(nil)
	_ Repo   = (*repo.Service)(nil)
)

// Attacher starts a tmux client for session on a new pty. ctx lives as
// long as the browser connection. The bridge ends when it is cancelled.
type Attacher func(ctx context.Context, session string, opts pty.Options) (Bridge, error)

// PtyAttach is the real Attacher.
func PtyAttach(ctx context.Context, session string, opts pty.Options) (Bridge, error) {
	b, err := pty.Attach(ctx, session, opts)
	if err != nil {
		// Never return a typed nil inside the interface.
		return nil, err
	}
	return b, nil
}

// Monitor is the session monitor as the node sees it. *monitor.Monitor
// satisfies it. Start begins polling and returns. Stop ends the polls and
// waits for them.
type Monitor interface {
	Start(ctx context.Context) error
	Stop()
}

var _ Monitor = (*monitor.Monitor)(nil)

// MonitorHooks is what the node gives the session monitor. The fields
// match monitor.Options, and New copies them across.
//
// The hooks are safe for concurrent use. Each one returns once every
// connection has its message, and the hub bounds every send.
type MonitorHooks struct {
	// Watched lists the sessions some connection is attached to, sorted
	// and without duplicates. Only those get window polls.
	Watched func() []string
	// OnSessionExit sends session:exited to every connection not attached
	// to name. Clones are skipped.
	OnSessionExit func(name string)
	// OnSessionCreated sends session:created to every connection. Clones
	// are skipped.
	OnSessionCreated func(session protocol.SessionInfo)
	// OnSessionRenamed moves the connections attached to oldName over to
	// newName. It sends nothing. OnSessionsChanged follows with the list.
	OnSessionRenamed func(oldName, newName string)
	// OnSessionsChanged sends session:list to every connection, clones
	// left out.
	OnSessionsChanged func(sessions []protocol.SessionInfo)
	// OnWindowsChanged sends window:changed and then pane:changed to the
	// connections attached to name. Clones are skipped.
	OnWindowsChanged func(name string, windows []protocol.WindowInfo)
}

// NewMonitor builds the session monitor around hooks. New passes one that
// creates the real monitor over the same tmux client.
type NewMonitor func(hooks MonitorHooks) Monitor

// Deps are the parts of the node that come from other packages. New
// builds the real ones. Tests pass fakes to NewWithDeps.
type Deps struct {
	// Tmux runs tmux commands. When nil, every terminal message fails with
	// ErrTmuxNotWired and Start does nothing.
	Tmux Tmux
	// Attach starts pty bridges. Nil means PtyAttach.
	Attach Attacher
	// NewMonitor builds the session monitor. Nil means no monitor.
	NewMonitor NewMonitor
	// Files runs the file messages and GET /file. When nil, every file
	// message and OpenFile fail with ErrFilesNotWired.
	Files *files.Service
	// Repo answers repo:request. When nil, repo:request fails with
	// ErrFilesNotWired.
	Repo Repo
	// Logger gets node records. Nil means slog.Default().
	Logger *slog.Logger
}
