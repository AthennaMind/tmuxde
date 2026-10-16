package client

import (
	"errors"
	"log/slog"
	"tmuxde/internal/protocol"
)

var terminalPreviewTypes = map[string]func() Message{
	"terminal:preview": func() Message { return &TerminalPreview{} },
}

// TerminalPreview replaces this connection's read-only screen subscription.
// Empty targets stop it. Once requests one snapshot without continued updates.
type TerminalPreview struct {
	Type            string                   `json:"type"`
	RequestID       string                   `json:"requestId"`
	Targets         []protocol.PreviewTarget `json:"targets"`
	ExcludeSessions []string                 `json:"excludeSessions"`
	Once            bool                     `json:"once"`
}

func (*TerminalPreview) WireType() string { return "terminal:preview" }
func (m *TerminalPreview) Validate() error {
	return errors.Join(protocol.Literal("type", m.Type, "terminal:preview"), protocol.LengthBetween("requestId", m.RequestID, 1, 128), protocol.RequiredSlice("targets", m.Targets), protocol.MaxItems("targets", m.Targets, 32), protocol.Each("targets", m.Targets), protocol.RequiredSlice("excludeSessions", m.ExcludeSessions), protocol.MaxItems("excludeSessions", m.ExcludeSessions, 1024))
}
func (m *TerminalPreview) LogValue() slog.Value {
	return slog.GroupValue(slog.String("type", m.Type), slog.Int("targets", len(m.Targets)))
}
