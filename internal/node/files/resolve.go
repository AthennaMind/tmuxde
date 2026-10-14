package files

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// maxLinks bounds the symlinks one resolution follows. Linux stops at 40
// too and answers ELOOP.
const maxLinks = 40

// realPath returns abs with every symlink resolved, like realpath(3). abs
// must be absolute and clean.
//
// A missing element is not an error. It and everything after it are kept
// as named, so a path that does not exist yet resolves to where it would
// be created. This holds for every missing ancestor, not just the parent.
// A dangling symlink is followed to its target in the same way, so a link
// to a missing place outside the allowed roots is judged by that place.
//
// Every errno other than ENOENT is returned, such as EACCES, ENOTDIR or
// ELOOP. ENOENT is returned too when ".." follows a missing element. The
// kernel fails there as well, and a lexical ".." could step back over a
// symlink without following it.
func realPath(abs string) (string, error) {
	resolved := "/"
	rest := abs
	links := 0
	for rest != "" {
		var name string
		name, rest, _ = strings.Cut(rest, "/")
		switch name {
		case "", ".":
			continue
		case "..":
			resolved = filepath.Dir(resolved)
			continue
		}
		next := filepath.Join(resolved, name)
		fi, err := os.Lstat(next)
		if err != nil {
			if !errors.Is(err, syscall.ENOENT) {
				return "", err
			}
			for part := range strings.SplitSeq(rest, "/") {
				if part == ".." {
					return "", &fs.PathError{Op: "realpath", Path: abs, Err: syscall.ENOENT}
				}
			}
			return filepath.Join(next, rest), nil
		}
		if fi.Mode()&fs.ModeSymlink == 0 {
			resolved = next
			continue
		}
		links++
		if links > maxLinks {
			return "", &fs.PathError{Op: "realpath", Path: abs, Err: syscall.ELOOP}
		}
		target, err := os.Readlink(next)
		if err != nil {
			return "", err
		}
		if filepath.IsAbs(target) {
			resolved = "/"
		}
		if rest != "" {
			target += "/" + rest
		}
		rest = target
	}
	return resolved, nil
}
