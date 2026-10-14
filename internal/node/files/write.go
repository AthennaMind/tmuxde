package files

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"unicode/utf8"

	"tmuxde/internal/node"
)

// Write replaces the content of an existing regular file, links followed.
// The limit counts UTF-8 bytes. The file must exist and be writable, as in
// the relay. file:create makes new files.
//
// The relay wrote in place, so a reader could see half a file. This writes
// a temp file next to the target and renames it over the target with the
// mode of the target. It writes in place instead when a rename would lose
// something: other hard links, an owner other than this process, or a
// directory this process may not write.
func (s *Service) Write(ctx context.Context, path, content string) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	_, real, err := s.guard.paths(path)
	if err != nil {
		return 0, fail(err)
	}
	size := len(content)
	if int64(size) > s.writeLimit {
		return 0, &Error{
			msg: fmt.Sprintf("File too large to write (%d bytes, max %d)", size, s.writeLimit),
			err: errTooLarge,
		}
	}
	if err := syscall.Access(real, accessWrite); err != nil {
		return 0, fail(&fs.PathError{Op: "access", Path: real, Err: err})
	}
	fi, err := os.Stat(real)
	if err != nil {
		return 0, fail(err)
	}
	switch {
	case fi.IsDir():
		return 0, fail(syscall.EISDIR)
	case !fi.Mode().IsRegular():
		return 0, &Error{msg: msgNotFile, err: node.ErrNotFile}
	}
	if err := replaceFile(real, fi, []byte(content)); err != nil {
		return 0, fail(err)
	}
	return size, nil
}

// replaceFile writes data over target. See Write.
func replaceFile(target string, fi fs.FileInfo, data []byte) error {
	if !renameKeeps(fi) {
		return writeInPlace(target, data)
	}
	f, tmp, err := createTemp(target, "write")
	if errors.Is(err, fs.ErrPermission) {
		return writeInPlace(target, data)
	}
	if err != nil {
		return err
	}
	err = f.Chmod(fi.Mode() & (fs.ModePerm | fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky))
	if err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, target)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// renameKeeps reports whether replacing the file by a rename keeps what
// the file has. A rename makes a new inode owned by this process, so other
// hard links would keep the old content and another owner would be lost.
func renameKeeps(fi fs.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return true
	}
	return uint64(st.Nlink) <= 1 && int(st.Uid) == os.Geteuid()
}

func writeInPlace(target string, data []byte) error {
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// tempNameMax keeps temp names under NAME_MAX, 255 bytes on Linux and
// macOS. The fixed parts take 32 bytes.
const tempNameMax = 200

// createTemp makes an empty file next to target, named
// .<name>.tmuxde-<kind>-<16 hex digits>. Mode is 0666 before umask. The
// watcher ignores these names.
func createTemp(target, kind string) (*os.File, string, error) {
	dir, name := filepath.Split(target)
	if len(name) > tempNameMax {
		cut := tempNameMax
		for cut > 0 && !utf8.RuneStart(name[cut]) {
			cut--
		}
		name = name[:cut]
	}
	for range 8 {
		var b [8]byte
		rand.Read(b[:])
		tmp := filepath.Join(dir, "."+name+".tmuxde-"+kind+"-"+hex.EncodeToString(b[:]))
		f, err := os.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o666)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		return f, tmp, err
	}
	return nil, "", &fs.PathError{Op: "createtemp", Path: dir, Err: syscall.EEXIST}
}

// Create makes a new file with content, mode 0666 before umask. An
// existing name fails with "File exists", a dangling symlink included.
func (s *Service) Create(ctx context.Context, path, content string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	lexical, _, err := s.guard.paths(path)
	if err != nil {
		return fail(err)
	}
	f, err := os.OpenFile(lexical, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		return fail(err)
	}
	_, err = f.WriteString(content)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(lexical)
		return fail(err)
	}
	return nil
}

// Mkdir makes one directory, mode 0777 before umask. Parents must exist.
func (s *Service) Mkdir(ctx context.Context, path string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	lexical, _, err := s.guard.paths(path)
	if err != nil {
		return fail(err)
	}
	return fail(os.Mkdir(lexical, 0o777))
}

// Delete removes a file, a symlink or a directory with everything in it.
// It refuses when the resolved path is an allowed root. Otherwise it acts
// on the path as named: a symlink is removed as a link, never its target,
// and the recursive delete never follows a link. A missing path is an
// error, as rm -r without force was in the relay.
func (s *Service) Delete(ctx context.Context, path string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	lexical, real, err := s.guard.paths(path)
	if err != nil {
		return fail(err)
	}
	if s.guard.isRoot(real) {
		return &Error{msg: msgRootDelete, err: errRootDelete}
	}
	fi, err := os.Lstat(lexical)
	if err != nil {
		return fail(err)
	}
	if fi.IsDir() {
		// RemoveAll opens each level with O_NOFOLLOW and unlinks links
		// as links.
		return fail(os.RemoveAll(lexical))
	}
	return fail(os.Remove(lexical))
}

// Rename moves oldPath to newPath with rename(2) on the paths as named,
// after both passed the guard. An existing file at newPath is replaced, as
// in the relay. A symlink moves as a link. Moves across file systems fail.
//
// A directory that holds a denied root is refused, in its named and its
// real form. Denied roots are fixed paths, so renaming ~/.config would
// make ~/.config/gh readable under the new name. The relay allowed it.
//
// Either side resolving to an allowed root is refused too, as Delete
// refuses it. A root configured through a symlink passes the guard by its
// name, and a rename must not move that link or put another one in its
// place.
func (s *Service) Rename(ctx context.Context, oldPath, newPath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	oldLexical, oldReal, err := s.guard.paths(oldPath)
	if err != nil {
		return fail(err)
	}
	newLexical, newReal, err := s.guard.paths(newPath)
	if err != nil {
		return fail(err)
	}
	switch {
	case s.guard.isRoot(oldReal) || s.guard.isRoot(newReal):
		return &Error{msg: msgRootRename, err: errRootRename}
	case s.guard.holdsDenied(oldLexical) || s.guard.holdsDenied(oldReal):
		return fail(node.ErrDenied)
	}
	return fail(os.Rename(oldLexical, newLexical))
}

// msgRootRename answers a rename from or onto an allowed root.
const msgRootRename = "Cannot rename an allowed root directory"

var errRootRename = errors.New("files: rename of an allowed root")
