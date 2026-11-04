package server

import (
	"errors"
	"log/slog"

	"tmuxde/internal/protocol"
)

var fileEditTypes = map[string]func() Message{
	"file:edit:result": func() Message { return &FileEditResult{} },
}

type FileEditOutcome struct {
	Status   string                 `json:"status"`
	Document *protocol.FileDocument `json:"document,omitempty"`
	Error    *string                `json:"error,omitempty"`
}

func (r FileEditOutcome) Validate() error {
	if r.Status == "error" {
		if r.Error == nil {
			return &protocol.FieldError{Field: "error", Reason: "is required"}
		}
		return protocol.MinLength("error", *r.Error, 1)
	}
	if r.Document == nil {
		return &protocol.FieldError{Field: "document", Reason: "is required"}
	}
	return errors.Join(
		protocol.OneOf("status", r.Status, "ok", "conflict"),
		protocol.Nested("document", *r.Document),
	)
}

type FileEditResult struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	Path      string          `json:"path"`
	Result    FileEditOutcome `json:"result"`
}

func (*FileEditResult) WireType() string {
	return "file:edit:result"
}

func (m *FileEditResult) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, m.WireType()),
		protocol.LengthBetween("requestId", m.RequestID, 1, 128),
		protocol.Nested("result", m.Result),
	)
}

func (m *FileEditResult) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("type", m.Type),
		slog.String("path", m.Path),
		slog.String("status", m.Result.Status),
	)
}
