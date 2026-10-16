// Package files is the file service of a node: path guards, listing,
// reading, writing, uploads, downloads and directory watchers. It is the Go
// port of apps/relay/src/file-service.ts.
//
// Every method checks its path with the Guard before it touches the file
// system. Errors are *Error values whose text is safe to send to the
// browser. Message gives the same text for any other error.
//
// Deliberate departures from the relay, from the porting spec:
//
//   - Uploads go to a temp file next to the target and replace it only on
//     the final chunk. An interrupted upload leaves the target as it was.
//   - Delete and rename act on the path as named after the guard passed. A
//     symlink is removed or moved as a link. Its target is never deleted.
//   - Path resolution walks every missing ancestor, not just the parent.
//   - Allowed root "/" holds every path. Empty config dir means home/.tmuxde.
//   - Write goes through a temp file and a rename. The file must exist.
//   - Error texts carry no path.
package files

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"tmuxde/internal/node"
	"tmuxde/internal/protocol"
)

// Limits from the relay.
const (
	// DefaultReadLimit is how much of a file Read returns.
	DefaultReadLimit = 100 * 1024
	// DefaultWriteLimit is the largest content Write accepts, in bytes.
	DefaultWriteLimit = 1024 * 1024
	// DefaultUploadLimit is the largest upload, all chunks together.
	DefaultUploadLimit = 1024 * 1024 * 1024
)

// Watcher timing from chokidar, which the relay used with its defaults.
const (
	// atomicDelay holds a file unlink back. A create of the same name in
	// that window turns both into one change, as an editor save does.
	atomicDelay = 100 * time.Millisecond
	// changeThrottle is the shortest gap between two change events for
	// one path.
	changeThrottle = 50 * time.Millisecond
)

// Modes for access(2), R_OK and W_OK in unistd.h. Package syscall does
// not name them.
const (
	accessRead  = 4
	accessWrite = 2
)

// Options configures New. Zero values pick the defaults.
type Options struct {
	// ReadLimit is DefaultReadLimit when zero or less.
	ReadLimit int64
	// WriteLimit is DefaultWriteLimit when zero or less.
	WriteLimit int64
	// UploadLimit is DefaultUploadLimit when zero or less.
	UploadLimit int64
	// Logger gets watcher errors. Nil means slog.Default().
	Logger *slog.Logger
}

// Service runs file operations for the browser. It is safe for concurrent
// use. Upload state lives in Uploads, one per connection.
type Service struct {
	guard       *Guard
	readLimit   int64
	writeLimit  int64
	uploadLimit int64
	log         *slog.Logger
	// Watcher timing, atomicDelay and changeThrottle.
	atomic   time.Duration
	throttle time.Duration
}

var _ node.FileOpener = (*Service)(nil)

// New builds the service around guard, which must not be nil.
func New(guard *Guard, opts Options) *Service {
	s := &Service{
		guard:       guard,
		readLimit:   opts.ReadLimit,
		writeLimit:  opts.WriteLimit,
		uploadLimit: opts.UploadLimit,
		log:         opts.Logger,
		atomic:      atomicDelay,
		throttle:    changeThrottle,
	}
	if s.readLimit <= 0 {
		s.readLimit = DefaultReadLimit
	}
	if s.writeLimit <= 0 {
		s.writeLimit = DefaultWriteLimit
	}
	if s.uploadLimit <= 0 {
		s.uploadLimit = DefaultUploadLimit
	}
	if s.log == nil {
		s.log = slog.Default()
	}
	return s
}

// Guard returns the guard the service checks paths with.
func (s *Service) Guard() *Guard { return s.guard }

// DefaultPath is where the file browser opens: the first allowed root
// resolved, else home, else "/".
func (s *Service) DefaultPath() string {
	return s.guard.defaultPath()
}

// List returns the entries of a directory, hidden ones included. Type
// comes from the directory entry without following links. Size and
// modified come from stat, which follows links. Entries whose stat fails,
// such as dangling links, are left out. Directories come first, then names
// in compareNames order. Path is the real directory joined with the name.
func (s *Service) List(ctx context.Context, path string) ([]protocol.FileEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	_, dir, err := s.guard.paths(path)
	if err != nil {
		return nil, fail(err)
	}
	f, err := os.Open(dir)
	if err != nil {
		return nil, fail(err)
	}
	defer f.Close()
	dirents, err := f.ReadDir(-1)
	if err != nil {
		return nil, fail(err)
	}
	entries := make([]protocol.FileEntry, 0, len(dirents))
	for _, d := range dirents {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		full := filepath.Join(dir, d.Name())
		fi, err := os.Stat(full)
		if err != nil {
			continue
		}
		entries = append(entries, protocol.FileEntry{
			Name:     d.Name(),
			Path:     full,
			Type:     direntType(d.Type()),
			Size:     float64(fi.Size()),
			Modified: isoTime(fi.ModTime()),
		})
	}
	slices.SortFunc(entries, sortEntries)
	return entries, nil
}

func direntType(m fs.FileMode) string {
	switch {
	case m.IsRegular():
		return "file"
	case m.IsDir():
		return "directory"
	case m&fs.ModeSymlink != 0:
		return "symlink"
	}
	return "other"
}

// statType is the type of a followed stat, never symlink.
func statType(m fs.FileMode) string {
	switch {
	case m.IsRegular():
		return "file"
	case m.IsDir():
		return "directory"
	}
	return "other"
}

// isoTime formats t as JavaScript toISOString does: UTC, milliseconds.
func isoTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// Read returns the text of a regular file, links followed. A file over
// the read limit is cut at the limit and truncated is true. A file of
// exactly the limit is not truncated. Invalid UTF-8 becomes U+FFFD. When
// the cut splits a character, its bytes are dropped instead. An incomplete
// character at the real end of a file still becomes U+FFFD.
func (s *Service) Read(ctx context.Context, path string) (content string, truncated bool, err error) {
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	_, real, err := s.guard.paths(path)
	if err != nil {
		return "", false, fail(err)
	}
	f, fi, err := openRegular(real)
	if err != nil {
		return "", false, fail(err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, s.readLimit+1))
	if err != nil {
		return "", false, fail(err)
	}
	truncated = int64(len(data)) > s.readLimit || fi.Size() > s.readLimit
	if int64(len(data)) > s.readLimit {
		data = data[:s.readLimit]
	}
	if truncated {
		data = data[:len(data)-partialTail(data)]
	}
	return strings.ToValidUTF8(string(data), "\uFFFD"), truncated, nil
}

// openRegular opens a regular file for reading. real must be fully
// resolved. It stats first so a device is never opened. O_NONBLOCK keeps
// a FIFO that appears in between from blocking the open. O_NOFOLLOW makes
// a symlink swapped in at the last element after the guard ran fail with
// ELOOP instead of being followed. The type is checked again on the open
// file.
func openRegular(real string) (*os.File, fs.FileInfo, error) {
	fi, err := os.Stat(real)
	if err != nil {
		return nil, nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, nil, &Error{msg: msgNotFile, err: node.ErrNotFile}
	}
	f, err := os.OpenFile(real, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, nil, err
	}
	fi, err = f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	if !fi.Mode().IsRegular() {
		f.Close()
		return nil, nil, &Error{msg: msgNotFile, err: node.ErrNotFile}
	}
	return f, fi, nil
}

// partialTail returns how many bytes at the end of b start a character
// that the end cuts short. It is 0 when b ends on a boundary or in bytes
// that are invalid anyway.
func partialTail(b []byte) int {
	for k := 1; k < utf8.UTFMax && k <= len(b); k++ {
		c := b[len(b)-k]
		if utf8.RuneStart(c) {
			if c >= utf8.RuneSelf && !utf8.FullRune(b[len(b)-k:]) {
				return k
			}
			return 0
		}
	}
	return 0
}

// Stat describes a path with links followed. Name and path are those of
// the real target. Created is the birth time where the platform records
// it, else the inode change time. Permissions come from access(2): "r",
// "rw" or "-". Write access is only tried after read access passed.
func (s *Service) Stat(ctx context.Context, path string) (protocol.FileStat, error) {
	if err := ctx.Err(); err != nil {
		return protocol.FileStat{}, err
	}
	_, real, err := s.guard.paths(path)
	if err != nil {
		return protocol.FileStat{}, fail(err)
	}
	fi, err := os.Stat(real)
	if err != nil {
		return protocol.FileStat{}, fail(err)
	}
	perms := "-"
	if syscall.Access(real, accessRead) == nil {
		perms = "r"
		if syscall.Access(real, accessWrite) == nil {
			perms = "rw"
		}
	}
	return protocol.FileStat{
		Name:        filepath.Base(real),
		Path:        real,
		Type:        statType(fi.Mode()),
		Size:        float64(fi.Size()),
		Modified:    isoTime(fi.ModTime()),
		Created:     isoTime(createdTime(real, fi)),
		Permissions: perms,
		IsReadable:  perms != "-",
		IsWritable:  perms == "rw",
	}, nil
}

// Open checks path and opens the real file read only for a download. It
// returns node.ErrDenied, node.ErrNotFile or node.ErrNotFound for the hub.
// The relay opened the path as sent after checking it. This opens the
// resolved path with O_NOFOLLOW, so a link swapped in at the last element
// in between is not followed. The open fails instead.
func (s *Service) Open(ctx context.Context, path string) (node.File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	_, real, err := s.guard.paths(path)
	if err != nil {
		return nil, openError(err)
	}
	f, _, err := openRegular(real)
	if err != nil {
		return nil, openError(err)
	}
	return f, nil
}

// OpenFile is Open under the name node.FileOpener asks for.
func (s *Service) OpenFile(ctx context.Context, path string) (node.File, error) {
	return s.Open(ctx, path)
}

func openError(err error) error {
	switch {
	case errors.Is(err, node.ErrDenied):
		return node.ErrDenied
	case errors.Is(err, node.ErrNotFile):
		return node.ErrNotFile
	case errors.Is(err, fs.ErrNotExist):
		return node.ErrNotFound
	}
	return err
}
