// Package node is the machine side of tmuxde: tmux, ptys, the session
// monitor, files, repositories and path guards for one machine.
//
// The hub reaches a node only through the Node interface. Client messages
// go in, server messages come out through a bounded Sink. A node never sees
// HTTP requests, origins or tokens. The hub authenticates the browser and
// passes only messages it has already decoded and allowed. The node still
// checks every path against its own guards and never trusts the hub for
// paths.
//
// Today the node runs in the same process as the hub. A remote node later
// implements the same interface over a network link, so nothing here may
// assume shared memory beyond the messages themselves.
package node

import (
	"context"
	"errors"
	"io"
	"io/fs"

	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// ConnID names one browser connection. The hub assigns it.
type ConnID uint64

// Node is the one interface between hub and node.
type Node interface {
	// Open starts a connection. Every server message for it, replies and
	// broadcasts alike, goes to out until Close returns.
	Open(ctx context.Context, id ConnID, out Sink) error
	// Handle processes one client message for an open connection. The hub
	// keeps auth, ping and dictation to itself and never passes them here.
	Handle(ctx context.Context, id ConnID, msg client.Message) error
	// Close ends a connection and releases its pty, watchers and state.
	Close(id ConnID)
}

// Sink takes server messages for one connection. It is bounded, so a slow
// browser slows the node down instead of growing memory.
type Sink interface {
	// Send queues msg. It blocks while the queue is full and returns
	// ctx.Err() when ctx ends first, or an error once the connection is
	// gone. A pty reader that blocks here stops reading, which is the
	// output backpressure.
	Send(ctx context.Context, msg server.Message) error
}

// File is an open regular file handed to the hub for one HTTP download.
// The node applies its path guards before it opens anything.
type File interface {
	io.ReadSeekCloser
	Stat() (fs.FileInfo, error)
}

// FileOpener is the download side of the node boundary. The hub serves
// GET /file through it and never touches the file system itself.
type FileOpener interface {
	// OpenFile checks the path against the guards and opens it read only.
	// It returns ErrDenied, ErrNotFile or ErrNotFound for the hub to map
	// to HTTP statuses. Any other error is a 404 as well, without detail.
	OpenFile(ctx context.Context, path string) (File, error)
}

// Sentinel errors for OpenFile.
var (
	// ErrDenied means the path is outside every allowed root or inside a
	// denied one. The hub answers 403 "Access denied".
	ErrDenied = errors.New("access denied")
	// ErrNotFile means the path exists but is not a regular file. The hub
	// answers 404 "Not a file".
	ErrNotFile = errors.New("not a file")
	// ErrNotFound means the path does not exist. The hub answers 404
	// "File not found".
	ErrNotFound = errors.New("file not found")
)
