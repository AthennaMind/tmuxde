package local

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"

	"tmuxde/internal/node"
	"tmuxde/internal/node/files"
	"tmuxde/internal/node/repo"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// Error codes and texts of the file handlers. The texts match the relay.
const (
	CodeAccessDenied = "ACCESS_DENIED"
	CodeWatchFailed  = "WATCH_FAILED"

	textAccessDenied    = "Path outside allowed directories"
	textWatchFailed     = "Failed to watch path"
	textTooManyWatchers = "Too many watchers"
	textNoPaneDirectory = "Pane directory is unavailable"
)

// defaultMaxWatchers caps the directory watchers of one connection. The
// relay had no cap. Each watcher holds an inotify instance, and those are
// a per user limit of the machine, often 128.
const defaultMaxWatchers = 32

// defaultMaxRepoWatchers caps the repository watches of one connection.
// Each holds one inotify instance and a watch per work tree directory.
const defaultMaxRepoWatchers = 4

// textTooManyRepoWatchers is the repo:watch:result message at the cap.
const textTooManyRepoWatchers = "Too many repository watchers"

// Texts for a failed operation whose error has no text of its own. The
// relay used them for a thrown value that was not an Error.
const (
	fallbackWrite  = "Write failed"
	fallbackCreate = "Create failed"
	fallbackMkdir  = "Mkdir failed"
	fallbackDelete = "Delete failed"
	fallbackRename = "Rename failed"
	fallbackUpload = "Upload failed"
)

// routeFile dispatches a file message. Every path is checked against the
// guard before the handler runs, as the relay router did. The file service
// checks it again.
func (n *Node) routeFile(ctx context.Context, c *conn, msg client.Message) error {
	switch m := msg.(type) {
	case *client.FileList:
		return n.guarded(ctx, c, func() error {
			entries, err := n.files.List(ctx, m.Path)
			if err != nil {
				return shortError{err}
			}
			return c.send(ctx, &server.FileList{Type: "file:list", Path: m.Path, Entries: orEmpty(entries)})
		}, m.Path)
	case *client.FileRead:
		return n.guarded(ctx, c, func() error {
			content, truncated, err := n.files.Read(ctx, m.Path)
			if err != nil {
				return shortError{err}
			}
			return c.send(ctx, &server.FileContent{Type: "file:content", Path: m.Path, Content: content, Truncated: truncated})
		}, m.Path)
	case *client.FileStat:
		return n.guarded(ctx, c, func() error {
			st, err := n.files.Stat(ctx, m.Path)
			if err != nil {
				return shortError{err}
			}
			return c.send(ctx, &server.FileStat{Type: "file:stat", Stat: st})
		}, m.Path)
	case *client.FileWatch:
		return n.guarded(ctx, c, func() error { return n.fileWatch(ctx, c, m.Path) }, m.Path)
	case *client.FileUnwatch:
		// Not guarded, as in the relay. It only looks up a watcher that
		// passed the guard when it was made.
		c.mu.Lock()
		w := c.watchers[m.Path]
		delete(c.watchers, m.Path)
		c.mu.Unlock()
		if w != nil {
			_ = w.Close()
		}
		return nil
	case *client.FileWrite:
		return n.guarded(ctx, c, func() error {
			size, err := n.files.Write(ctx, m.Path, m.Content)
			res := &server.FileWriteResult{Type: "file:write:result", Path: m.Path, Success: err == nil}
			if err != nil {
				res.Error = ptrTo(failText(err, fallbackWrite))
			} else {
				res.Size = ptrTo(float64(size))
			}
			return c.send(ctx, res)
		}, m.Path)
	case *client.FileCreate:
		return n.guarded(ctx, c, func() error {
			content := ""
			if m.Content != nil {
				content = *m.Content
			}
			err := n.files.Create(ctx, m.Path, content)
			return c.send(ctx, opResult("create", m.Path, err, fallbackCreate))
		}, m.Path)
	case *client.FileMkdir:
		return n.guarded(ctx, c, func() error {
			err := n.files.Mkdir(ctx, m.Path)
			return c.send(ctx, opResult("mkdir", m.Path, err, fallbackMkdir))
		}, m.Path)
	case *client.FileDelete:
		return n.guarded(ctx, c, func() error {
			err := n.files.Delete(ctx, m.Path)
			return c.send(ctx, opResult("delete", m.Path, err, fallbackDelete))
		}, m.Path)
	case *client.FileRename:
		return n.guarded(ctx, c, func() error {
			err := n.files.Rename(ctx, m.OldPath, m.NewPath)
			// The reply names the new path, as in the relay.
			return c.send(ctx, opResult("rename", m.NewPath, err, fallbackRename))
		}, m.OldPath, m.NewPath)
	case *client.FileUpload:
		return n.guarded(ctx, c, func() error { return n.fileUpload(ctx, c, m) }, m.Path)
	}
	return fmt.Errorf("%w: %s", ErrNotImplemented, msg.WireType())
}

// guarded runs fn when every path passes the guard. A path the guard
// denies is answered with ACCESS_DENIED and fn does not run. Empty and
// relative paths are denied. A path that fails to resolve for another
// reason, such as a parent without search permission, still reaches fn,
// which reports the error in its own reply, as the relay did.
func (n *Node) guarded(ctx context.Context, c *conn, fn func() error, paths ...string) error {
	g := n.files.Guard()
	for _, p := range paths {
		if _, err := g.Resolve(p); errors.Is(err, node.ErrDenied) {
			return c.send(ctx, errorMsg(CodeAccessDenied, textAccessDenied))
		}
	}
	return fn()
}

// fileWatch starts a watcher for path. The key is the path as sent, so a
// second watch of the same text does nothing, as in the relay. Success
// sends no reply. Events go out as file:changed until file:unwatch or
// Close.
func (n *Node) fileWatch(ctx context.Context, c *conn, path string) error {
	c.mu.Lock()
	_, dup := c.watchers[path]
	full := len(c.watchers) >= n.maxWatchers
	c.mu.Unlock()
	switch {
	case dup:
		return nil
	case full:
		return c.send(ctx, errorMsg(CodeWatchFailed, textTooManyWatchers))
	}
	// Under the connection context, not the message context: the watcher
	// lives until unwatch or Close. Close cancels it, which also ends a
	// send that waits for room in the sink.
	w, err := n.files.Watch(c.ctx, path, func(changed, event string) {
		msg := &server.FileChanged{Type: "file:changed", Path: changed, Event: event}
		if err := c.sink.Send(c.ctx, msg); err != nil && c.ctx.Err() == nil {
			n.log.Debug("file change not sent", "conn", c.id, "error", err)
		}
	})
	if err != nil {
		return c.send(ctx, errorMsg(CodeWatchFailed, failText(err, textWatchFailed)))
	}
	c.mu.Lock()
	if c.closed {
		// Close ran while the watcher started and took the map before
		// this one was in it.
		c.mu.Unlock()
		_ = w.Close()
		return nil
	}
	if c.watchers == nil {
		c.watchers = map[string]*files.Watcher{}
	}
	c.watchers[path] = w
	c.mu.Unlock()
	return nil
}

// fileUpload adds one chunk. Chunks go to a temp file next to the target,
// and the final chunk renames it over the target. A plain chunk gets no
// reply. A final chunk or one with ack gets file:op:result, and final is
// echoed only when ack was set, as the relay did. A failure gets a reply,
// except a plain chunk refused because an earlier chunk of its upload
// failed. That failure was reported already, and the final chunk reports
// it again, so the browser does not show one error per chunk.
//
// A chunk that runs after Close is refused by the closed Uploads, so it
// cannot leave a temp file behind.
func (n *Node) fileUpload(ctx context.Context, c *conn, m *client.FileUpload) error {
	err := c.uploads.Chunk(ctx, m.Path, decodeBase64(m.Content), m.Final)
	ack := m.Ack != nil && *m.Ack
	if errors.Is(err, files.ErrUploadAborted) && !ack {
		return nil
	}
	if err != nil {
		return c.send(ctx, opResult("upload", m.Path, err, fallbackUpload))
	}
	if !m.Final && !ack {
		return nil
	}
	res := opResult("upload", m.Path, nil, "")
	if ack {
		res.Final = ptrTo(m.Final)
	}
	return c.send(ctx, res)
}

// repoRequest answers repo:request. The pane must belong to the attached
// session, the ownership rule, and its directory comes from tmux, never
// from the browser. One unscoped list-panes gives both. Every refusal is a
// repo:result of kind error with the request id, so the browser can match
// it to its request.
func (n *Node) repoRequest(ctx context.Context, c *conn, m *client.RepoRequest) error {
	if n.repo == nil {
		return &notWiredError{wireType: m.WireType(), missing: ErrFilesNotWired}
	}
	s := c.attachedSession()
	if s == "" {
		return c.send(ctx, repo.ErrorResult(m.RequestID, textNotAttached))
	}
	panes, err := n.tmux.ListPanes(ctx, s, "")
	if err != nil {
		// A failed lookup refuses, as in the ownership rule.
		n.log.Warn("ownership lookup failed", "conn", c.id, "session", s, "error", err)
		return c.send(ctx, repo.ErrorResult(m.RequestID, paneNotFound(m.ID)))
	}
	i := slices.IndexFunc(panes, func(p protocol.PaneInfo) bool { return p.ID == m.ID })
	if i < 0 {
		return c.send(ctx, repo.ErrorResult(m.RequestID, paneNotFound(m.ID)))
	}
	dir := panes[i].Path
	if dir == nil || *dir == "" {
		return c.send(ctx, repo.ErrorResult(m.RequestID, textNoPaneDirectory))
	}
	if m.Action == "search" {
		searchCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		stop := context.AfterFunc(c.ctx, cancel)
		defer stop()
		return c.send(ctx, n.repo.Request(searchCtx, *dir, m))
	}
	return c.send(ctx, n.repo.Request(ctx, *dir, m))
}

// repoWatch answers repo:watch. The pane must belong to the attached
// session, as for repo:request, and the watch starts from its folder as
// tmux reports it, or from the captured context path. Every refusal is a
// repo:watch:result with ok false, never an error message, so the browser
// falls back to polling without a toast. A second watch of the same root
// answers ok and changes nothing.
func (n *Node) repoWatch(ctx context.Context, c *conn, m *client.RepoWatch) error {
	if n.repo == nil {
		return &notWiredError{wireType: m.WireType(), missing: ErrFilesNotWired}
	}
	refuse := func(root *string, text string) error {
		return c.send(ctx, &server.RepoWatchResult{Type: "repo:watch:result", Root: root, Message: &text})
	}
	s := c.attachedSession()
	if s == "" {
		return refuse(nil, textNotAttached)
	}
	panes, err := n.tmux.ListPanes(ctx, s, "")
	if err != nil {
		n.log.Warn("ownership lookup failed", "conn", c.id, "session", s, "error", err)
		return refuse(nil, paneNotFound(m.ID))
	}
	i := slices.IndexFunc(panes, func(p protocol.PaneInfo) bool { return p.ID == m.ID })
	if i < 0 {
		return refuse(nil, paneNotFound(m.ID))
	}
	dir := panes[i].Path
	if dir == nil || *dir == "" {
		return refuse(nil, textNoPaneDirectory)
	}
	root, err := n.repo.WatchRoot(ctx, *dir, m.Path)
	if err != nil {
		return refuse(nil, repo.Message(err))
	}
	c.mu.Lock()
	existing, dup := c.repoWatchers[root]
	full := len(c.repoWatchers) >= n.maxRepoWatchers
	c.mu.Unlock()
	switch {
	case dup:
		return c.send(ctx, &server.RepoWatchResult{Type: "repo:watch:result", Root: &root, OK: true, Partial: existing.Partial()})
	case full:
		return refuse(&root, textTooManyRepoWatchers)
	}
	// Under the connection context, as file:watch: the watch lives until
	// repo:unwatch or Close.
	w, err := n.repo.Watch(c.ctx, root, func(msg server.Message) {
		if err := c.sink.Send(c.ctx, msg); err != nil && c.ctx.Err() == nil {
			n.log.Debug("repository change not sent", "conn", c.id, "error", err)
		}
	})
	if err != nil {
		return refuse(&root, repo.Message(err))
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		_ = w.Close()
		return nil
	}
	if c.repoWatchers == nil {
		c.repoWatchers = map[string]repo.WatchHandle{}
	}
	c.repoWatchers[root] = w
	c.mu.Unlock()
	return c.send(ctx, &server.RepoWatchResult{Type: "repo:watch:result", Root: &root, OK: true, Partial: w.Partial()})
}

// repoUnwatch stops the watch of a root. It only looks up a watch that
// passed every check when it started, and sends nothing.
func (n *Node) repoUnwatch(c *conn, m *client.RepoUnwatch) error {
	c.mu.Lock()
	w := c.repoWatchers[m.Root]
	delete(c.repoWatchers, m.Root)
	c.mu.Unlock()
	if w != nil {
		_ = w.Close()
	}
	return nil
}

// opResult builds file:op:result. err nil is success.
func opResult(op, path string, err error, fallback string) *server.FileOpResult {
	res := &server.FileOpResult{Type: "file:op:result", Op: op, Path: path, Success: err == nil}
	if err != nil {
		res.Error = ptrTo(failText(err, fallback))
	}
	return res
}

// failText is the browser text for a failed file operation. It never
// holds a path. fallback stands in for an error without text.
func failText(err error, fallback string) string {
	if msg := files.Message(err); msg != "" {
		return msg
	}
	return fallback
}

// shortError reads as the short browser text of err, so the hub's
// HANDLER_ERROR carries no path. errors.Is and errors.As still see err.
type shortError struct{ err error }

func (e shortError) Error() string { return failText(e.err, "Internal error") }

func (e shortError) Unwrap() error { return e.err }

func ptrTo[T any](v T) *T { return &v }

// decodeBase64 decodes as Buffer.from(s, "base64") in Node, which the
// relay used, and never fails. Decoding stops at the first "=". "-" and
// "_" count as "+" and "/". Any other byte outside the alphabet, such as
// white space, is skipped. A single character left at the end holds no
// whole byte and is dropped.
func decodeBase64(s string) []byte {
	clean := make([]byte, 0, len(s))
scan:
	for i := 0; i < len(s); i++ {
		switch b := s[i]; {
		case b == '=':
			break scan
		case b == '-':
			clean = append(clean, '+')
		case b == '_':
			clean = append(clean, '/')
		case 'A' <= b && b <= 'Z', 'a' <= b && b <= 'z', '0' <= b && b <= '9', b == '+', b == '/':
			clean = append(clean, b)
		}
	}
	if len(clean)%4 == 1 {
		clean = clean[:len(clean)-1]
	}
	out := make([]byte, base64.RawStdEncoding.DecodedLen(len(clean)))
	// Clean input of any length but 1 mod 4 decodes. The encoding is not
	// strict, so stray low bits in the last character are ignored, as
	// Node ignores them.
	k, _ := base64.RawStdEncoding.Decode(out, clean)
	return out[:k]
}
