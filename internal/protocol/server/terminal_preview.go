package server

import (
	"errors"
	"log/slog"
	"tmuxde/internal/protocol"
)

var terminalPreviewTypes = map[string]func() Message{
	"terminal:preview:frame": func() Message { return &TerminalPreviewFrame{} },
}

// TerminalPreviewFrame contains only screens changed since the previous frame.
type TerminalPreviewFrame struct {
	Type      string                  `json:"type"`
	RequestID string                  `json:"requestId"`
	Frames    []protocol.PreviewFrame `json:"frames"`
}

func (*TerminalPreviewFrame) WireType() string { return "terminal:preview:frame" }
func (m *TerminalPreviewFrame) Validate() error {
	return errors.Join(protocol.Literal("type", m.Type, "terminal:preview:frame"), protocol.LengthBetween("requestId", m.RequestID, 1, 128), protocol.RequiredSlice("frames", m.Frames), protocol.MaxItems("frames", m.Frames, 32), protocol.Each("frames", m.Frames))
}
func (m *TerminalPreviewFrame) LogValue() slog.Value {
	return slog.GroupValue(slog.String("type", m.Type), slog.Int("frames", len(m.Frames)))
}
