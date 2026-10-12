package files

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"syscall"
	"unicode"
	"unicode/utf8"

	"tmuxde/internal/node"
)

// Error is a failed file operation as the browser sees it. Error returns
// a short message without the path. Unwrap returns the cause, so
// errors.Is still finds node.ErrDenied, node.ErrNotFile, fs.ErrNotExist
// and the like.
type Error struct {
	msg string
	err error
}

func (e *Error) Error() string { return e.msg }

func (e *Error) Unwrap() error { return e.err }

// Messages the relay sent for its own checks. The router reports a guard
// failure itself with code ACCESS_DENIED.
const (
	msgDenied     = "Access denied: path outside allowed directories"
	msgNotFile    = "Not a file"
	msgRootDelete = "Cannot delete an allowed root directory"
)

var (
	errTooLarge   = errors.New("files: too large")
	errRootDelete = errors.New("files: allowed root")
)

// Message returns the browser text for err. It never contains a path.
// The relay sent raw Node errno strings with the path inside. Common errno
// values get fixed texts here. Others use the system text with a capital
// first letter.
func Message(err error) string {
	var fe *Error
	var pe *fs.PathError
	var le *os.LinkError
	var se *os.SyscallError
	var errno syscall.Errno
	switch {
	case err == nil:
		return ""
	case errors.As(err, &fe):
		return fe.msg
	case errors.Is(err, node.ErrDenied):
		return msgDenied
	case errors.Is(err, node.ErrNotFile):
		return msgNotFile
	case errors.As(err, &errno):
		return errnoMessage(errno)
	case errors.As(err, &pe):
		return Message(pe.Err)
	case errors.As(err, &le):
		return Message(le.Err)
	case errors.As(err, &se):
		return Message(se.Err)
	}
	return err.Error()
}

func errnoMessage(errno syscall.Errno) string {
	switch errno {
	case syscall.ENOENT:
		return "No such file or directory"
	case syscall.EACCES:
		return "Permission denied"
	case syscall.EEXIST:
		return "File exists"
	case syscall.EISDIR:
		return "Is a directory"
	case syscall.ENOTDIR:
		return "Not a directory"
	}
	s := errno.Error()
	r, n := utf8.DecodeRuneInString(s)
	return string(unicode.ToUpper(r)) + s[n:]
}

// fail turns err into an *Error with its Message. Context errors and
// errors that already are an *Error pass through.
func fail(err error) error {
	var fe *Error
	switch {
	case err == nil:
		return nil
	case errors.As(err, &fe), errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	}
	return &Error{msg: Message(err), err: err}
}
