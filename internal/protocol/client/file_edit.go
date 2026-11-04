package client

import (
	"errors"
	"log/slog"

	"tmuxde/internal/protocol"
)

var fileEditTypes = map[string]func() Message{
	"file:edit:read": func() Message { return &FileEditRead{} },
	"file:edit:save": func() Message { return &FileEditSave{} },
}

type FileEditRead struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Path      string `json:"path"`
}

func (*FileEditRead) WireType() string {
	return "file:edit:read"
}

func (m *FileEditRead) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, m.WireType()),
		protocol.LengthBetween("requestId", m.RequestID, 1, 128),
	)
}

// FileEditSave never falls back to an unconditional write.
type FileEditSave struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Path      string `json:"path"`
	Content   string `json:"content"`
	Revision  string `json:"revision"`
}

func (*FileEditSave) WireType() string {
	return "file:edit:save"
}

func (m *FileEditSave) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, m.WireType()),
		protocol.LengthBetween("requestId", m.RequestID, 1, 128),
		protocol.FileRevision("revision", m.Revision),
	)
}

func (m *FileEditSave) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("type", m.Type),
		slog.String("path", m.Path),
		slog.Int("contentLength", len(m.Content)),
	)
}
