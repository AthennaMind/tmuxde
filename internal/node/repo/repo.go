// Package repo is the repository viewer of a node. It is the Go port of
// the relay's repository-service.ts.
//
// Every request starts from the selected pane's directory. Paths go through
// the node's Guard before anything reads them. Git metadata is inspected
// before Git runs, so symlinks, object alternates and configuration
// includes or filters cannot reach files the guard would refuse. Git runs
// without a shell, with a clean environment, a timeout and a cap on its
// output.
//
// Departures from the relay, all deliberate:
//
//   - A Git timeout is the error "Git request timed out". The relay took a
//     killed Git for exit code 0 and answered with empty output.
//   - Status drops a rename or copy record whose original path was cut off
//     by the output cap.
//   - A configuration include or filter section is also refused when it
//     follows another section header on the same line. Git reads
//     "[core] [include]" as two sections and the relay missed the second.
//   - Commit patches are split only at line starts after "\n". The relay
//     also split after "\r", so file content could shift patches between
//     files.
//   - Errors from the file system reach the browser as short messages
//     without the path. Git runs in its own process group, and a timeout
//     kills the whole group. AUTH_TOKEN never reaches Git.
//   - Values the protocol already refuses, an unknown action or scope and
//     a skip out of range, get an error here too instead of falling
//     through to another action.
package repo

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"tmuxde/internal/node"
	"tmuxde/internal/node/files"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// Guard is the node's path guard. Package files implements it. The
// repository service only consumes it.
type Guard interface {
	// Resolve returns the real absolute path. Missing ancestors are resolved one by one up to the first existing one, so a path that does not exist yet still resolves. Any errno other than ENOENT is returned as an error. The result is node.ErrDenied when the real path or the lexical path is outside every allowed root or inside a denied root.
	Resolve(path string) (string, error)
	// Allowed reports whether an already resolved path is inside an allowed root and outside every denied root.
	Allowed(path string) bool
}

// Defaults for Options, the relay's limits.
const (
	defaultTimeout     = 5 * time.Second
	defaultOutputLimit = 512 * 1024
	defaultReadLimit   = 100 * 1024
	defaultMaxEntries  = 2000
	defaultPageSize    = 100

	// metadataEntryLimit caps the entries one Git directory walk inspects.
	metadataEntryLimit = 100_000
	// maxSkip is the largest log offset, as the protocol allows.
	maxSkip = 1_000_000
)

// Options configures a Service. Zero values pick the defaults.
type Options struct {
	// Timeout bounds one Git call and one Git metadata walk. Default 5 s.
	Timeout time.Duration
	// OutputLimit caps Git output in bytes. Output past it is cut and the
	// result is marked truncated. Default 524288.
	OutputLimit int
	// ReadLimit caps a file read in bytes. Default 102400.
	ReadLimit int
	// MaxEntries caps directory entries, status entries and commit files.
	// Default 2000.
	MaxEntries int
	// PageSize is the number of commits in one log page. Default 100.
	PageSize int
	// Watch configures repository watchers. Zero values pick the defaults.
	Watch WatchOptions
	// Logger gets one record per failed request. Default slog.Default().
	Logger *slog.Logger
}

// Service answers repo:request for one machine. It is safe for concurrent use.
// Filename searches run one at a time to bound filesystem work.
type Service struct {
	searchMu sync.Mutex
	guard    Guard
	opts     Options
	log      *slog.Logger
	// bin is the Git program. exec looks it up on PATH at each call.
	bin string
	// env is the environment every Git call gets, built from the process
	// environment at New.
	env []string
}

// New returns a service that checks every path with g. It panics when g is
// nil.
func New(g Guard, opts Options) *Service {
	if g == nil {
		panic("repo: nil guard")
	}
	if opts.Timeout <= 0 {
		opts.Timeout = defaultTimeout
	}
	if opts.OutputLimit <= 0 {
		opts.OutputLimit = defaultOutputLimit
	}
	if opts.ReadLimit <= 0 {
		opts.ReadLimit = defaultReadLimit
	}
	if opts.MaxEntries <= 0 {
		opts.MaxEntries = defaultMaxEntries
	}
	if opts.PageSize <= 0 {
		opts.PageSize = defaultPageSize
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	opts.Watch = opts.Watch.withDefaults()
	return &Service{guard: g, opts: opts, log: opts.Logger, bin: "git", env: gitEnv(os.Environ())}
}

// ErrorResult wraps message as a repo:result of kind error. The router uses
// it for refusals that happen before the service runs, such as "No session
// attached", "Pane not found" and "Pane directory is unavailable".
func ErrorResult(requestID, message string) *server.RepoResult {
	return &server.RepoResult{
		Type:      "repo:result",
		RequestID: requestID,
		Result:    &protocol.RepoError{Kind: "error", Message: message},
	}
}

// Request runs one repository request from the pane directory cwd. It
// always returns a result. Failures, permission denials included, come
// back as kind error with a message that is safe to show.
func (s *Service) Request(ctx context.Context, cwd string, req *client.RepoRequest) *server.RepoResult {
	if req == nil {
		return ErrorResult("", msgUnknownAction)
	}
	result, err := s.handle(ctx, cwd, req)
	if err != nil {
		msg, known := publicMessage(err)
		level := slog.LevelDebug
		if !known {
			level = slog.LevelWarn
		}
		s.log.LogAttrs(ctx, level, "repository request failed",
			slog.String("requestId", req.RequestID),
			slog.String("action", req.Action),
			slog.String("message", msg),
			slog.Any("err", err))
		return ErrorResult(req.RequestID, msg)
	}
	return &server.RepoResult{Type: "repo:result", RequestID: req.RequestID, Result: result}
}

func (s *Service) handle(ctx context.Context, cwd string, req *client.RepoRequest) (protocol.RepoResult, error) {
	cwd, err := s.checked(cwd)
	if err != nil {
		return nil, err
	}
	path := deref(req.Path)
	switch req.Action {
	case "search":
		if !s.searchMu.TryLock() {
			return nil, fail("Another file search is running. Try again.")
		}
		defer s.searchMu.Unlock()
		query := strings.TrimSpace(deref(req.Query))
		if query == "" || len([]rune(query)) > 256 {
			return nil, fail("Enter a filename or path, up to 256 characters")
		}
		dir := cwd
		if path != "" {
			dir = resolvePath(cwd, path)
		}
		result, err := files.Search(ctx, s.guard, dir, query)
		if err != nil {
			return nil, err
		}
		return &protocol.RepoSearch{Kind: "search", Path: result.Path, Files: result.Files, Truncated: result.Truncated}, nil
	case "list":
		dir := cwd
		if path != "" {
			dir = resolvePath(cwd, path)
		}
		return s.list(ctx, dir)
	case "read":
		if path == "" {
			return nil, fail(msgPathRequired)
		}
		file, err := s.checked(resolvePath(cwd, path))
		if err != nil {
			return nil, err
		}
		t, err := s.textFile(file)
		if err != nil {
			return nil, err
		}
		return &protocol.RepoRead{Kind: "read", Path: file, Content: t.content, Truncated: t.truncated, Binary: t.binary}, nil
	case "context", "status", "diff", "log", "show":
	default:
		return nil, fail(msgUnknownAction)
	}

	start := cwd
	if req.Action != "context" && path != "" {
		start = resolvePath(cwd, path)
	}
	repo, err := s.discover(ctx, start)
	if err != nil {
		return nil, err
	}
	switch req.Action {
	case "context":
		result := &protocol.RepoContext{Kind: "context", Path: cwd}
		if repo != nil {
			branch, err := s.branch(ctx, *repo)
			if err != nil {
				return nil, err
			}
			result.Root = &repo.root
			result.Branch = branch
		}
		return result, nil
	case "status":
		return s.status(ctx, repo)
	case "log":
		if repo == nil {
			return &protocol.RepoLog{Kind: "log", Commits: []protocol.RepoCommit{}}, nil
		}
		skip := 0
		if req.Skip != nil {
			skip = *req.Skip
		}
		if skip < 0 || skip > maxSkip {
			return nil, fail(msgInvalidSkip)
		}
		return s.history(ctx, *repo, skip, req.All != nil && *req.All)
	}
	if repo == nil {
		return nil, fail(msgNotRepository)
	}
	if req.Action == "show" {
		commit := deref(req.Commit)
		if commit == "" {
			return nil, fail(msgCommitRequired)
		}
		return s.show(ctx, *repo, commit)
	}
	return s.diff(ctx, *repo, deref(req.File), deref(req.Scope))
}

// Messages a result of kind error carries. The first group is the relay's,
// word for word.
const (
	msgDenied         = "Access denied: path outside allowed directories"
	msgNotRegular     = "Not a regular file"
	msgMetadata       = "Unsupported Git metadata"
	msgNotDirectory   = "Not a directory"
	msgPointer        = "Invalid Git directory pointer"
	msgInspection     = "Git metadata exceeds inspection limit"
	msgSymlinks       = "Access denied: Git metadata symlinks are unsupported"
	msgAlternates     = "Access denied: Git object alternates are unsupported"
	msgIncludes       = "Access denied: Git configuration includes and filters are unsupported"
	msgTimeout        = "Git request timed out"
	msgGitFailed      = "Could not read repository"
	msgPathRequired   = "File path required"
	msgNotRepository  = "Current pane directory is not a Git repository"
	msgFileScope      = "File and change scope required"
	msgOutsideRepo    = "Access denied: file outside repository"
	msgInvalidCommit  = "Invalid commit"
	msgCommitRequired = "Commit required"
	msgCommitNotFound = "Commit not found"

	// The protocol refuses these before the service runs.
	msgUnknownAction = "Unknown repository action"
	msgInvalidSkip   = "Invalid skip"

	msgCanceled = "Request canceled"
	msgExpired  = "Request timed out"
)

// requestError is a failure whose message is safe to show. Err is the
// cause for the log and may name paths.
type requestError struct {
	msg string
	err error
}

func (e *requestError) Error() string {
	if e.err == nil {
		return e.msg
	}
	return e.msg + ": " + e.err.Error()
}

func (e *requestError) Unwrap() error { return e.err }

func fail(msg string) error { return &requestError{msg: msg} }

func failWith(msg string, err error) error { return &requestError{msg: msg, err: err} }

// publicMessage turns err into text for the browser. File system errors
// become their short errno text without the path. known is false for
// errors with no better text than the fallback.
func publicMessage(err error) (msg string, known bool) {
	var re *requestError
	var errno syscall.Errno
	switch {
	case errors.As(err, &re):
		return re.msg, true
	case errors.Is(err, node.ErrDenied):
		return msgDenied, true
	case errors.Is(err, context.Canceled):
		return msgCanceled, true
	case errors.Is(err, context.DeadlineExceeded):
		return msgExpired, true
	case errors.Is(err, fs.ErrPermission):
		// EPERM and EACCES read the same to the user.
		return "Permission denied", true
	case errors.As(err, &errno):
		return capitalize(errno.Error()), true
	}
	return msgGitFailed, false
}

func capitalize(s string) string {
	if s == "" || s[0] < 'a' || s[0] > 'z' {
		return s
	}
	return string(s[0]-'a'+'A') + s[1:]
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// isRepoScope reports whether scope is one the protocol knows.
func isRepoScope(scope string) bool {
	return slices.Contains(protocol.RepoScopes, scope)
}

// jsTrim trims what JavaScript String.prototype.trim trims.
func jsTrim(s string) string {
	return strings.TrimFunc(s, isJSSpace)
}

// isJSSpace reports whether JavaScript \s matches r.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// jsSpaceClass is isJSSpace as the inside of a regexp character class.
const jsSpaceClass = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`
