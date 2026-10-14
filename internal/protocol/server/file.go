package server

import (
	"encoding/json"
	"errors"
	"log/slog"

	"tmuxde/internal/protocol"
)

var fileTypes = map[string]func() Message{
	"file:list":         func() Message { return &FileList{} },
	"file:content":      func() Message { return &FileContent{} },
	"file:stat":         func() Message { return &FileStat{} },
	"file:changed":      func() Message { return &FileChanged{} },
	"file:write:result": func() Message { return &FileWriteResult{} },
	"file:op:result":    func() Message { return &FileOpResult{} },
	"repo:result":       func() Message { return &RepoResult{} },
}

// FileChangeEvents are the values of file:changed event.
var FileChangeEvents = []string{"add", "change", "unlink", "addDir", "unlinkDir"}

// FileOps are the values of file:op:result op.
var FileOps = []string{"create", "mkdir", "delete", "rename", "upload"}

// FileList answers file:list.
type FileList struct {
	Type    string               `json:"type"`
	Path    string               `json:"path"`
	Entries []protocol.FileEntry `json:"entries"`
}

func (*FileList) WireType() string { return "file:list" }

func (m *FileList) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "file:list"),
		protocol.RequiredSlice("entries", m.Entries),
		protocol.Each("entries", m.Entries),
	)
}

// FileContent answers file:read. Truncated is true when the file was cut
// at the read limit.
type FileContent struct {
	Type      string `json:"type"`
	Path      string `json:"path"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
}

func (*FileContent) WireType() string { return "file:content" }

func (m *FileContent) Validate() error {
	return protocol.Literal("type", m.Type, "file:content")
}

// LogValue logs the content size, not the content.
func (m *FileContent) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("type", m.Type),
		slog.String("path", m.Path),
		slog.Int("contentLength", len(m.Content)),
		slog.Bool("truncated", m.Truncated),
	)
}

// FileStat answers file:stat.
type FileStat struct {
	Type string            `json:"type"`
	Stat protocol.FileStat `json:"stat"`
}

func (*FileStat) WireType() string { return "file:stat" }

func (m *FileStat) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "file:stat"),
		protocol.Nested("stat", m.Stat),
	)
}

// FileChanged reports a change inside a watched directory. Event names
// follow chokidar.
type FileChanged struct {
	Type  string `json:"type"`
	Path  string `json:"path"`
	Event string `json:"event"`
}

func (*FileChanged) WireType() string { return "file:changed" }

func (m *FileChanged) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "file:changed"),
		protocol.OneOf("event", m.Event, FileChangeEvents...),
	)
}

// FileWriteResult answers file:write. Size is the written size in bytes.
// Error is set on failure.
type FileWriteResult struct {
	Type    string   `json:"type"`
	Path    string   `json:"path"`
	Success bool     `json:"success"`
	Error   *string  `json:"error,omitempty"`
	Size    *float64 `json:"size,omitempty"`
}

func (*FileWriteResult) WireType() string { return "file:write:result" }

func (m *FileWriteResult) Validate() error {
	return protocol.Literal("type", m.Type, "file:write:result")
}

// FileOpResult answers create, mkdir, delete, rename and upload. Final
// echoes the chunk flag of an acknowledged upload.
type FileOpResult struct {
	Type    string  `json:"type"`
	Op      string  `json:"op"`
	Path    string  `json:"path"`
	Success bool    `json:"success"`
	Error   *string `json:"error,omitempty"`
	Final   *bool   `json:"final,omitempty"`
}

func (*FileOpResult) WireType() string { return "file:op:result" }

func (m *FileOpResult) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "file:op:result"),
		protocol.OneOf("op", m.Op, FileOps...),
	)
}

// RepoResult answers repo:request with the same RequestID. Result is one
// of the protocol.Repo* payloads, chosen by its kind.
type RepoResult struct {
	Type      string              `json:"type"`
	RequestID string              `json:"requestId"`
	Result    protocol.RepoResult `json:"result"`
}

func (*RepoResult) WireType() string { return "repo:result" }

func (m *RepoResult) Validate() error {
	err := protocol.Literal("type", m.Type, "repo:result")
	if m.Result == nil {
		return errors.Join(err, &protocol.FieldError{Field: "result", Reason: "required"})
	}
	return errors.Join(err, protocol.Nested("result", m.Result))
}

// UnmarshalJSON picks the result struct by kind. Decode has already checked
// the outer keys.
func (m *RepoResult) UnmarshalJSON(data []byte) error {
	var wire struct {
		Type      string          `json:"type"`
		RequestID string          `json:"requestId"`
		Result    json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	result, err := protocol.DecodeRepoResult(wire.Result)
	if err != nil {
		return protocol.Within("result", err)
	}
	*m = RepoResult{Type: wire.Type, RequestID: wire.RequestID, Result: result}
	return nil
}

// LogValue logs the request and kind, not file content or patches.
func (m *RepoResult) LogValue() slog.Value {
	kind := ""
	if m.Result != nil {
		kind = m.Result.RepoKind()
	}
	return slog.GroupValue(
		slog.String("type", m.Type),
		slog.String("requestId", m.RequestID),
		slog.String("kind", kind),
	)
}
