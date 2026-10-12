//go:build darwin

package files

import (
	"io/fs"
	"syscall"
	"time"
)

// createdTime is the birth time, which every macOS file system records.
func createdTime(_ string, fi fs.FileInfo) time.Time {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return time.Unix(st.Birthtimespec.Unix())
	}
	return fi.ModTime()
}
