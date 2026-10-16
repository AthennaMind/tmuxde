package client

import (
	"errors"
	"log/slog"
	"strings"

	"tmuxde/internal/protocol"
)

var terminalSearchTypes = map[string]func() Message{
	"terminal:search": func() Message { return &TerminalSearch{} },
}

// TerminalSearch reads history without attaching or selecting a session.
type TerminalSearch struct {
	Type            string   `json:"type"`
	RequestID       string   `json:"requestId"`
	Query           string   `json:"query"`
	CaseSensitive   bool     `json:"caseSensitive"`
	ExcludeSessions []string `json:"excludeSessions"`
}

func (*TerminalSearch) WireType() string { return "terminal:search" }

func (m *TerminalSearch) Validate() error {
	var queryErr error
	if strings.TrimSpace(m.Query) == "" || strings.ContainsAny(m.Query, "\r\n\x00") {
		queryErr = &protocol.FieldError{Field: "query", Reason: "must be nonblank single-line text"}
	}
	return errors.Join(
		protocol.Literal("type", m.Type, "terminal:search"),
		protocol.LengthBetween("requestId", m.RequestID, 1, 128),
		protocol.LengthBetween("query", m.Query, 1, 256),
		queryErr,
		protocol.RequiredSlice("excludeSessions", m.ExcludeSessions),
		protocol.MaxItems("excludeSessions", m.ExcludeSessions, 1024),
	)
}

func (m *TerminalSearch) LogValue() slog.Value {
	return slog.GroupValue(slog.String("type", m.Type), slog.Int("queryLength", len(m.Query)))
}
