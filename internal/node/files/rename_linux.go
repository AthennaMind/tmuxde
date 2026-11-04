package files

import "golang.org/x/sys/unix"

// Linux rejects collisions atomically, even against external writers.
func renameExclusive(from, to string) error {
	return unix.Renameat2(unix.AT_FDCWD, from, unix.AT_FDCWD, to, unix.RENAME_NOREPLACE)
}
