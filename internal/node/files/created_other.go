//go:build !linux && !darwin

package files

import (
	"io/fs"
	"time"
)

// createdTime falls back to the modification time. Linux and macOS have
// their own versions with birth time.
func createdTime(_ string, fi fs.FileInfo) time.Time {
	return fi.ModTime()
}
