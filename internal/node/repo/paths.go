package repo

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"tmuxde/internal/node"
	"tmuxde/internal/node/files"
	"tmuxde/internal/protocol"
)

var (
	// pointerPattern is the content of a .git file. The relay's
	// /^gitdir: (.+)\r?\n?$/, where . stops at every JavaScript line
	// terminator.
	pointerPattern = regexp.MustCompile(`^gitdir: ([^\n\r\x{2028}\x{2029}]+)\r?\n?$`)

	// configPattern finds include, includeIf and filter sections. The
	// relay matched /^\s*\[\s*(?:include(?:if)?|filter)[\s.\]"]/im, so
	// only at a line start. Git also starts a section right after the
	// "]" of another one on the same line, so that counts as a start too.
	configPattern = regexp.MustCompile(`(?i)(?:\A|[\n\r\x{2028}\x{2029}\]])[` + jsSpaceClass + `]*\[[` +
		jsSpaceClass + `]*(?:include(?:if)?|filter)[` + jsSpaceClass + `.\]"]`)
)

// repository is a discovered work tree and its Git directory, both real
// paths.
type repository struct {
	root   string
	gitdir string
}

// checked resolves p with the guard. Relative and empty paths are refused
// here too, whatever the guard does with them.
func (s *Service) checked(p string) (string, error) {
	if !filepath.IsAbs(p) {
		return "", node.ErrDenied
	}
	return s.guard.Resolve(p)
}

// resolvePath is Node path.resolve(base, p) for an absolute base.
func resolvePath(base, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(base, p)
}

// inside reports whether file is root or below it. Root "/" holds every
// absolute path.
func inside(file, root string) bool {
	if root == "/" {
		return strings.HasPrefix(file, "/")
	}
	return file == root || strings.HasPrefix(file, root+"/")
}

// exists is lstat without following a final symlink. Only ENOENT means
// false. Any other error is returned.
func exists(p string) (bool, error) {
	_, err := os.Lstat(p)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return false, err
}

// text is a bounded file read.
type text struct {
	content   string
	truncated bool
	binary    bool
}

// textFile reads at most ReadLimit bytes of a regular file. A NUL byte in
// them marks it binary and leaves content empty.
func (s *Service) textFile(p string) (text, error) {
	safe, err := s.checked(p)
	if err != nil {
		return text{}, err
	}
	// O_NONBLOCK so a FIFO does not block the open. Stat refuses it next.
	// safe is fully resolved, so its last element is never a link unless
	// one was swapped in after the guard ran. O_NOFOLLOW fails that open
	// with ELOOP instead of following the link.
	f, err := os.OpenFile(safe, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return text{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return text{}, err
	}
	if !st.Mode().IsRegular() {
		return text{}, fail(msgNotRegular)
	}
	limit := s.opts.ReadLimit
	buf := make([]byte, limit+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return text{}, err
	}
	data := buf[:min(n, limit)]
	t := text{
		truncated: n > limit || st.Size() > int64(limit),
		binary:    bytes.IndexByte(data, 0) >= 0,
	}
	if !t.binary {
		t.content = decodeUTF8(data, n > limit)
	}
	return t, nil
}

// metadataFile reads a small Git metadata file as text.
func (s *Service) metadataFile(p string) (string, error) {
	t, err := s.textFile(p)
	if err != nil {
		return "", err
	}
	if t.truncated || t.binary {
		return "", fail(msgMetadata)
	}
	return t.content, nil
}

// validateGitDirectory walks a Git directory before Git reads it. Git
// follows these paths while reading configuration, refs and objects.
// Metadata symlinks and alternates are refused so none bypass file
// permissions. Includes and filters are refused because they read other
// files or run programs. The walk runs on every request and is capped in
// entries and time.
func (s *Service) validateGitDirectory(ctx context.Context, dir string) error {
	if _, err := s.checked(dir); err != nil {
		return err
	}
	w := metadataWalk{s: s, deadline: time.Now().Add(s.opts.Timeout), pending: []string{dir}}
	for len(w.pending) > 0 {
		next := w.pending[len(w.pending)-1]
		w.pending = w.pending[:len(w.pending)-1]
		if err := w.inspect(ctx, next); err != nil {
			return err
		}
	}
	return nil
}

type metadataWalk struct {
	s        *Service
	count    int
	deadline time.Time
	pending  []string
}

func (w *metadataWalk) inspect(ctx context.Context, dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	for {
		batch, readErr := f.ReadDir(256)
		for _, e := range batch {
			w.count++
			if w.count > metadataEntryLimit || time.Now().After(w.deadline) {
				return fail(msgInspection)
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := w.entry(dir, e); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func (w *metadataWalk) entry(dir string, e fs.DirEntry) error {
	name := e.Name()
	file := filepath.Join(dir, name)
	switch {
	case e.Type()&fs.ModeSymlink != 0:
		return fail(msgSymlinks)
	case e.IsDir():
		if name != "hooks" && name != "logs" {
			w.pending = append(w.pending, file)
		}
	case name == "alternates" || name == "http-alternates":
		content, err := w.s.metadataFile(file)
		if err != nil {
			return err
		}
		if jsTrim(content) != "" {
			return fail(msgAlternates)
		}
	case name == "config" || name == "config.worktree":
		content, err := w.s.metadataFile(file)
		if err != nil {
			return err
		}
		if configPattern.MatchString(content) {
			return fail(msgIncludes)
		}
	}
	return nil
}

// discover finds the repository that holds start. It walks up until a
// .git entry turns up, the file system root is reached or the parent is
// outside the allowed roots. A nil repository means none.
func (s *Service) discover(ctx context.Context, start string) (*repository, error) {
	root, err := s.checked(start)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, fail(msgNotDirectory)
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		dotgit := filepath.Join(root, ".git")
		found, err := exists(dotgit)
		if err != nil {
			return nil, err
		}
		if found {
			return s.openRepository(ctx, root, dotgit)
		}
		parent := filepath.Dir(root)
		if parent == root || !s.guard.Allowed(parent) {
			return nil, nil
		}
		if root, err = s.checked(parent); err != nil {
			return nil, err
		}
	}
}

func (s *Service) openRepository(ctx context.Context, root, dotgit string) (*repository, error) {
	if _, err := s.checked(root); err != nil {
		return nil, err
	}
	gitdir, err := s.checked(dotgit)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(gitdir)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		content, err := s.metadataFile(gitdir)
		if err != nil {
			return nil, err
		}
		m := pointerPattern.FindStringSubmatch(content)
		if m == nil {
			return nil, fail(msgPointer)
		}
		if gitdir, err = s.checked(resolvePath(root, m[1])); err != nil {
			return nil, err
		}
	}
	if err := s.validateGitDirectory(ctx, gitdir); err != nil {
		return nil, err
	}
	commonFile := filepath.Join(gitdir, "commondir")
	found, err := exists(commonFile)
	if err != nil {
		return nil, err
	}
	if found {
		content, err := s.metadataFile(commonFile)
		if err != nil {
			return nil, err
		}
		common, err := s.checked(resolvePath(gitdir, jsTrim(content)))
		if err != nil {
			return nil, err
		}
		if err := s.validateGitDirectory(ctx, common); err != nil {
			return nil, err
		}
	}
	return &repository{root: root, gitdir: gitdir}, nil
}

// list reads one directory. Entries the guard refuses or that cannot be
// stat'ed are left out. Types follow symlinks.
func (s *Service) list(ctx context.Context, dir string) (*protocol.RepoList, error) {
	safe, err := s.checked(dir)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(safe)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	entries := []protocol.FileEntry{}
	truncated := false
	inspected := 0
read:
	for {
		batch, readErr := f.ReadDir(256)
		for _, e := range batch {
			inspected++
			if inspected > s.opts.MaxEntries {
				truncated = true
				break read
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			file := filepath.Join(safe, e.Name())
			if _, err := s.checked(file); err != nil {
				continue
			}
			st, err := os.Stat(file)
			if err != nil {
				continue
			}
			entries = append(entries, protocol.FileEntry{
				Name:     e.Name(),
				Path:     file,
				Type:     entryType(st),
				Size:     float64(st.Size()),
				Modified: isoTime(st.ModTime()),
			})
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, readErr
		}
	}
	slices.SortStableFunc(entries, compareEntries)
	return &protocol.RepoList{Kind: "list", Path: safe, Entries: entries, Truncated: truncated}, nil
}

func entryType(st fs.FileInfo) string {
	switch {
	case st.IsDir():
		return "directory"
	case st.Mode().IsRegular():
		return "file"
	}
	return "other"
}

// isoTime is JavaScript Date.toISOString.
func isoTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// compareEntries puts directories first, then sorts by name.
func compareEntries(a, b protocol.FileEntry) int {
	ad, bd := a.Type == "directory", b.Type == "directory"
	if ad != bd {
		if ad {
			return -1
		}
		return 1
	}
	return compareNames(a.Name, b.Name)
}

// compareNames stands in for the relay's localeCompare. It is the order
// of file:list, so the repository list and the file tree sort alike.
func compareNames(a, b string) int { return files.CompareNames(a, b) }

// decodeUTF8 is Node's lossy UTF-8 decode. When the bytes were cut at a
// limit, an incomplete last sequence is dropped instead of becoming
// U+FFFD.
func decodeUTF8(b []byte, cut bool) string {
	if cut {
		b = trimIncomplete(b)
	}
	if utf8.Valid(b) {
		return string(b)
	}
	return strings.ToValidUTF8(string(b), "\uFFFD")
}

func trimIncomplete(b []byte) []byte {
	for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax; i-- {
		if utf8.RuneStart(b[i]) {
			if !utf8.FullRune(b[i:]) {
				return b[:i]
			}
			return b
		}
	}
	return b
}
