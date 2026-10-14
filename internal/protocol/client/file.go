package client

import (
	"errors"
	"log/slog"

	"tmuxde/internal/protocol"
)

var fileTypes = map[string]func() Message{
	"file:list":    func() Message { return &FileList{} },
	"file:read":    func() Message { return &FileRead{} },
	"file:stat":    func() Message { return &FileStat{} },
	"file:watch":   func() Message { return &FileWatch{} },
	"file:unwatch": func() Message { return &FileUnwatch{} },
	"file:write":   func() Message { return &FileWrite{} },
	"file:create":  func() Message { return &FileCreate{} },
	"file:mkdir":   func() Message { return &FileMkdir{} },
	"file:delete":  func() Message { return &FileDelete{} },
	"file:rename":  func() Message { return &FileRename{} },
	"file:upload":  func() Message { return &FileUpload{} },
	"repo:request": func() Message { return &RepoRequest{} },
}

// Every path below is checked against the allowed paths by the handler.
// The schema only requires a string.

// FileList asks for the entries of a directory.
type FileList struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

func (*FileList) WireType() string { return "file:list" }

func (m *FileList) Validate() error {
	return protocol.Literal("type", m.Type, "file:list")
}

// FileRead asks for the content of a file.
type FileRead struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

func (*FileRead) WireType() string { return "file:read" }

func (m *FileRead) Validate() error {
	return protocol.Literal("type", m.Type, "file:read")
}

// FileStat asks for the metadata of a path.
type FileStat struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

func (*FileStat) WireType() string { return "file:stat" }

func (m *FileStat) Validate() error {
	return protocol.Literal("type", m.Type, "file:stat")
}

// FileWatch starts watching a directory, without subdirectories.
type FileWatch struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

func (*FileWatch) WireType() string { return "file:watch" }

func (m *FileWatch) Validate() error {
	return protocol.Literal("type", m.Type, "file:watch")
}

// FileUnwatch stops watching a directory.
type FileUnwatch struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

func (*FileUnwatch) WireType() string { return "file:unwatch" }

func (m *FileUnwatch) Validate() error {
	return protocol.Literal("type", m.Type, "file:unwatch")
}

// FileWrite overwrites a file with Content.
type FileWrite struct {
	Type    string `json:"type"`
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (*FileWrite) WireType() string { return "file:write" }

func (m *FileWrite) Validate() error {
	return protocol.Literal("type", m.Type, "file:write")
}

// LogValue logs the content size, not the content.
func (m *FileWrite) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("type", m.Type),
		slog.String("path", m.Path),
		slog.Int("contentLength", len(m.Content)),
	)
}

// FileCreate creates a file. Content is optional, and an empty string is a
// valid content.
type FileCreate struct {
	Type    string  `json:"type"`
	Path    string  `json:"path"`
	Content *string `json:"content,omitempty"`
}

func (*FileCreate) WireType() string { return "file:create" }

func (m *FileCreate) Validate() error {
	return protocol.Literal("type", m.Type, "file:create")
}

// LogValue logs the content size, not the content.
func (m *FileCreate) LogValue() slog.Value {
	attrs := []slog.Attr{slog.String("type", m.Type), slog.String("path", m.Path)}
	if m.Content != nil {
		attrs = append(attrs, slog.Int("contentLength", len(*m.Content)))
	}
	return slog.GroupValue(attrs...)
}

// FileMkdir creates a directory.
type FileMkdir struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

func (*FileMkdir) WireType() string { return "file:mkdir" }

func (m *FileMkdir) Validate() error {
	return protocol.Literal("type", m.Type, "file:mkdir")
}

// FileDelete deletes a file or directory.
type FileDelete struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

func (*FileDelete) WireType() string { return "file:delete" }

func (m *FileDelete) Validate() error {
	return protocol.Literal("type", m.Type, "file:delete")
}

// FileRename renames or moves a path.
type FileRename struct {
	Type    string `json:"type"`
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
}

func (*FileRename) WireType() string { return "file:rename" }

func (m *FileRename) Validate() error {
	return protocol.Literal("type", m.Type, "file:rename")
}

// FileUpload is one chunk of an upload. Content is base64. The schema does
// not check the encoding, the handler does. Final marks the last chunk.
// With Ack set, every chunk is answered by file:op:result.
type FileUpload struct {
	Type    string `json:"type"`
	Path    string `json:"path"`
	Content string `json:"content"`
	Final   bool   `json:"final"`
	Ack     *bool  `json:"ack,omitempty"`
}

func (*FileUpload) WireType() string { return "file:upload" }

func (m *FileUpload) Validate() error {
	return protocol.Literal("type", m.Type, "file:upload")
}

// LogValue logs the chunk size, not the chunk.
func (m *FileUpload) LogValue() slog.Value {
	attrs := []slog.Attr{
		slog.String("type", m.Type),
		slog.String("path", m.Path),
		slog.Int("contentLength", len(m.Content)),
		slog.Bool("final", m.Final),
	}
	if m.Ack != nil {
		attrs = append(attrs, slog.Bool("ack", *m.Ack))
	}
	return slog.GroupValue(attrs...)
}

// RepoRequest asks the repository viewer for one action on the pane ID.
// The schema does not tie fields to actions. Which fields an action needs
// is checked by the handler, which answers repo:result with kind error.
// Skip and All are for log, Commit for show.
type RepoRequest struct {
	Type      string  `json:"type"`
	RequestID string  `json:"requestId"`
	ID        string  `json:"id"`
	Action    string  `json:"action"`
	Path      *string `json:"path,omitempty"`
	File      *string `json:"file,omitempty"`
	Scope     *string `json:"scope,omitempty"`
	Skip      *int    `json:"skip,omitempty"`
	Commit    *string `json:"commit,omitempty"`
	// All asks log for every branch, tag and remote branch, not only HEAD.
	All *bool `json:"all,omitempty"`
}

func (*RepoRequest) WireType() string { return "repo:request" }

func (m *RepoRequest) Validate() error {
	err := errors.Join(
		protocol.Literal("type", m.Type, "repo:request"),
		protocol.LengthBetween("requestId", m.RequestID, 1, 128),
		protocol.MinLength("id", m.ID, 1),
		protocol.OneOf("action", m.Action, protocol.RepoActions...),
	)
	if m.Scope != nil {
		err = errors.Join(err, protocol.OneOf("scope", *m.Scope, protocol.RepoScopes...))
	}
	if m.Skip != nil {
		err = errors.Join(err, protocol.Between("skip", *m.Skip, 0, 1_000_000))
	}
	if m.Commit != nil {
		err = errors.Join(err, protocol.Pattern("commit", *m.Commit, protocol.RepoCommitPattern))
	}
	return err
}
