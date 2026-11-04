//go:build !linux

package files

import (
	"errors"
	"os"
)

// Portable rename checks destination first. External writers do not share
// service mutex, so this is not an atomic no-replace operation on these systems.
func renameExclusive(from, to string) error {
	if _, err := os.Lstat(to); err == nil {
		return os.ErrExist
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(from, to)
}
