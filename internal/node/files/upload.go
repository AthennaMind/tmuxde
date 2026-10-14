package files

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sync"
	"syscall"
)

// ErrUploadAborted marks a chunk refused because an earlier chunk of the
// same upload failed. That failure was reported already, so a caller may
// stay silent about this one. The final chunk returns the first error
// instead.
var ErrUploadAborted = errors.New("files: upload aborted by an earlier chunk")

// errUploadsClosed refuses a chunk that comes after Cleanup.
var errUploadsClosed = errors.New("files: uploads closed")

const msgUploadFailed = "Upload failed"

// Uploads holds the chunked uploads of one connection. Keeping them per
// connection means two connections cannot corrupt each other's partial
// files, and a disconnect cleans up only its own. Safe for concurrent use.
//
// The relay wrote the first chunk over the target. An interrupted upload
// followed by the disconnect cleanup then deleted the original file. Here
// chunks go to a temp file next to the target. Only the final chunk renames
// it over the target.
//
// Chunks carry no offset. The browser sends them back to back without
// waiting for a reply. So a chunk that fails marks its target as failed,
// and the rest of that upload is refused up to its final chunk. Without
// the mark the next chunk would start a new upload, and the final rename
// would put only the tail over the target.
type Uploads struct {
	svc *Service
	mu  sync.Mutex
	// open maps the real target path to its upload.
	open map[string]*upload
	// failed maps the real target path of an upload that failed before
	// its final chunk to the first error.
	failed map[string]error
	// closed is set by Cleanup. Later chunks are refused.
	closed bool
}

type upload struct {
	temp string
	size int64
}

// NewUploads returns the upload state for one connection. Call Cleanup
// when the connection ends.
func (s *Service) NewUploads() *Uploads {
	return &Uploads{svc: s, open: make(map[string]*upload), failed: make(map[string]error)}
}

// Chunk adds data to the upload for path. The first chunk creates the temp
// file .<name>.tmuxde-upload-<random> next to the target. Later chunks
// append. With final set the temp file replaces the target, mode 0666
// before umask. The caller decodes base64.
//
// When the total passes the upload limit the temp file is removed, the
// upload is dropped and the error is "Upload too large (N bytes, max M)".
// Any other failure drops the upload too. The target is never touched
// until the final rename.
//
// When a chunk that is not final fails, the later chunks of that upload
// fail with ErrUploadAborted and the text of the first error. Its final
// chunk returns the first error itself and ends the upload. The chunk
// after that starts a new one. After Cleanup every chunk fails.
func (u *Uploads) Chunk(ctx context.Context, path string, data []byte, final bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, real, err := u.svc.guard.paths(path)
	if err != nil {
		return fail(err)
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return &Error{msg: msgUploadFailed, err: errUploadsClosed}
	}
	if first, ok := u.failed[real]; ok {
		if final {
			delete(u.failed, real)
			return first
		}
		return &Error{msg: Message(first), err: ErrUploadAborted}
	}
	if err := u.add(real, data, final); err != nil {
		u.drop(real)
		if !final {
			u.failed[real] = err
		}
		return err
	}
	return nil
}

// add writes one chunk for real. On error the caller drops the upload.
// The caller holds mu.
func (u *Uploads) add(real string, data []byte, final bool) error {
	up := u.open[real]
	size := int64(len(data))
	if up != nil {
		size += up.size
	}
	if size > u.svc.uploadLimit {
		return &Error{
			msg: fmt.Sprintf("Upload too large (%d bytes, max %d)", size, u.svc.uploadLimit),
			err: errTooLarge,
		}
	}
	if up == nil {
		if fi, err := os.Lstat(real); err == nil && fi.IsDir() {
			return fail(syscall.EISDIR)
		}
		f, tmp, err := createTemp(real, "upload")
		if err != nil {
			return fail(err)
		}
		if err := f.Close(); err != nil {
			os.Remove(tmp)
			return fail(err)
		}
		up = &upload{temp: tmp}
		u.open[real] = up
	}
	if err := appendTo(up.temp, data, final); err != nil {
		return fail(err)
	}
	up.size = size
	if !final {
		return nil
	}
	delete(u.open, real)
	if err := os.Rename(up.temp, real); err != nil {
		u.remove(up.temp)
		return fail(err)
	}
	return nil
}

// appendTo adds data to the temp file. It refuses to follow a link put in
// its place. With sync set the data reaches the disk before the rename.
func appendTo(temp string, data []byte, sync bool) error {
	f, err := os.OpenFile(temp, os.O_WRONLY|os.O_APPEND|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil && sync {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// Cleanup removes the temp file of every upload still open and forgets
// them. Targets are never touched. Chunks that come later fail, so none
// can leave a temp file behind. Call it when the connection ends. It is
// safe to call more than once.
func (u *Uploads) Cleanup() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.closed = true
	for real := range u.open {
		u.drop(real)
	}
	clear(u.failed)
}

// drop removes the temp file of the upload for real and forgets it. The
// caller holds mu.
func (u *Uploads) drop(real string) {
	if up, ok := u.open[real]; ok {
		delete(u.open, real)
		u.remove(up.temp)
	}
}

func (u *Uploads) remove(temp string) {
	if err := os.Remove(temp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		u.svc.log.Warn("files: remove upload temp file", "err", err)
	}
}
