package server

import (
	"errors"
	"log/slog"

	"tmuxde/internal/protocol"
)

var terminalSearchTypes = map[string]func() Message{
	"terminal:search:result": func() Message { return &TerminalSearchResult{} },
}

type TerminalSearchResult struct {
	Type          string                         `json:"type"`
	RequestID     string                         `json:"requestId"`
	Matches       []protocol.TerminalSearchMatch `json:"matches"`
	SearchedPanes int                            `json:"searchedPanes"`
	SkippedPanes  int                            `json:"skippedPanes"`
	Partial       bool                           `json:"partial"`
	Error         *string                        `json:"error,omitempty"`
}

func (*TerminalSearchResult) WireType() string { return "terminal:search:result" }

func (m *TerminalSearchResult) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "terminal:search:result"),
		protocol.LengthBetween("requestId", m.RequestID, 1, 128),
		protocol.RequiredSlice("matches", m.Matches),
		protocol.MaxItems("matches", m.Matches, 100),
		protocol.Each("matches", m.Matches),
		protocol.Min("searchedPanes", m.SearchedPanes, 0),
		protocol.Min("skippedPanes", m.SkippedPanes, 0),
	)
}

func (m *TerminalSearchResult) LogValue() slog.Value {
	return slog.GroupValue(slog.String("type", m.Type), slog.Int("matches", len(m.Matches)))
}
