//go:build linux

package files

import (
	"io/fs"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// createdTime is the birth time from statx when the file system records
// it. Else it is the change time, the time of the last inode change. Node
// reported birthtime from statx too.
func createdTime(path string, fi fs.FileInfo) time.Time {
	var stx unix.Statx_t
	err := unix.Statx(unix.AT_FDCWD, path, 0, unix.STATX_BTIME, &stx)
	if err == nil && stx.Mask&unix.STATX_BTIME != 0 {
		return time.Unix(stx.Btime.Sec, int64(stx.Btime.Nsec))
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return time.Unix(st.Ctim.Unix())
	}
	return fi.ModTime()
}
