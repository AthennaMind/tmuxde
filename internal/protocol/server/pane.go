package server

import (
	"errors"
	"log/slog"

	"tmuxde/internal/protocol"
)

var paneTypes = map[string]func() Message{
	"terminal:output":   func() Message { return &TerminalOutput{} },
	"pane:list":         func() Message { return &PaneList{} },
	"pane:changed":      func() Message { return &PaneChanged{} },
	"pane:captured":     func() Message { return &PaneCaptured{} },
	"tmux:scroll-state": func() Message { return &TmuxScrollState{} },
}

// TerminalOutput is PTY output for the attached session.
type TerminalOutput struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

func (*TerminalOutput) WireType() string { return "terminal:output" }

func (m *TerminalOutput) Validate() error {
	return protocol.Literal("type", m.Type, "terminal:output")
}

// LogValue logs the output size, not the output.
func (m *TerminalOutput) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("type", m.Type),
		slog.Int("dataLength", len(m.Data)),
	)
}

// PaneList answers pane:list with the panes of window WindowID.
type PaneList struct {
	Type     string              `json:"type"`
	Panes    []protocol.PaneInfo `json:"panes"`
	WindowID string              `json:"windowId"`
}

func (*PaneList) WireType() string { return "pane:list" }

func (m *PaneList) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "pane:list"),
		protocol.RequiredSlice("panes", m.Panes),
		protocol.Each("panes", m.Panes),
	)
}

// PaneChanged says the pane layout of window WindowID changed. It has the
// same shape as PaneList but nobody asked for it.
type PaneChanged struct {
	Type     string              `json:"type"`
	Panes    []protocol.PaneInfo `json:"panes"`
	WindowID string              `json:"windowId"`
}

func (*PaneChanged) WireType() string { return "pane:changed" }

func (m *PaneChanged) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "pane:changed"),
		protocol.RequiredSlice("panes", m.Panes),
		protocol.Each("panes", m.Panes),
	)
}

// PaneCaptured answers pane:capture with the pane's contents as text.
type PaneCaptured struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Content string `json:"content"`
}

func (*PaneCaptured) WireType() string { return "pane:captured" }

func (m *PaneCaptured) Validate() error {
	return protocol.Literal("type", m.Type, "pane:captured")
}

// LogValue logs the pane and the content size, not the content.
func (m *PaneCaptured) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("type", m.Type),
		slog.String("id", m.ID),
		slog.Int("contentLength", len(m.Content)),
	)
}

// TmuxScrollState is where the attached pane's view sits in tmux history.
// Position is lines back from the live output, so 0 is the bottom.
// HistorySize is the lines above the PaneHeight visible rows. InMode is
// tmux pane_in_mode. Outside copy mode the view is at the bottom.
type TmuxScrollState struct {
	Type        string `json:"type"`
	Position    int    `json:"position"`
	HistorySize int    `json:"historySize"`
	PaneHeight  int    `json:"paneHeight"`
	InMode      bool   `json:"inMode"`
}

func (*TmuxScrollState) WireType() string { return "tmux:scroll-state" }

func (m *TmuxScrollState) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "tmux:scroll-state"),
		protocol.Min("position", m.Position, 0),
		protocol.Min("historySize", m.HistorySize, 0),
		protocol.Min("paneHeight", m.PaneHeight, 0),
	)
}
