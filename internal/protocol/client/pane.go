package client

import (
	"errors"
	"log/slog"

	"tmuxde/internal/protocol"
)

var paneTypes = map[string]func() Message{
	"terminal:input":      func() Message { return &TerminalInput{} },
	"terminal:resize":     func() Message { return &TerminalResize{} },
	"pane:list":           func() Message { return &PaneList{} },
	"pane:split":          func() Message { return &PaneSplit{} },
	"pane:select":         func() Message { return &PaneSelect{} },
	"pane:zoom":           func() Message { return &PaneZoom{} },
	"pane:step":           func() Message { return &PaneStep{} },
	"pane:resize":         func() Message { return &PaneResize{} },
	"pane:kill":           func() Message { return &PaneKill{} },
	"pane:swap":           func() Message { return &PaneSwap{} },
	"pane:join":           func() Message { return &PaneJoin{} },
	"pane:break":          func() Message { return &PaneBreak{} },
	"pane:capture":        func() Message { return &PaneCapture{} },
	"tmux:prefix":         func() Message { return &TmuxPrefix{} },
	"tmux:copy-mode":      func() Message { return &TmuxCopyMode{} },
	"tmux:scroll":         func() Message { return &TmuxScroll{} },
	"tmux:scroll-to":      func() Message { return &TmuxScrollTo{} },
	"tmux:scroll-state":   func() Message { return &TmuxScrollState{} },
	"tmux:exit-copy-mode": func() Message { return &TmuxExitCopyMode{} },
	"command:send":        func() Message { return &CommandSend{} },
	"command:interrupt":   func() Message { return &CommandInterrupt{} },
	"command:eof":         func() Message { return &CommandEOF{} },
	"command:clear":       func() Message { return &CommandClear{} },
	"command:suspend":     func() Message { return &CommandSuspend{} },
}

// SplitDirections are the values of PaneSplit.Direction and
// PaneJoin.Direction. "h" puts the new pane beside the old one, "v" below
// it.
var SplitDirections = []string{"h", "v"}

// PaneDirections are the values of PaneResize.Direction and
// PaneSwap.Direction: up, down, left, right.
var PaneDirections = []string{"U", "D", "L", "R"}

// Bounds of TmuxScroll.Lines. One message cannot walk an unbounded history.
const (
	MinScrollLines = -500
	MaxScrollLines = 500
)

// TerminalInput is keystrokes for the attached PTY.
type TerminalInput struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

func (*TerminalInput) WireType() string { return "terminal:input" }

func (m *TerminalInput) Validate() error {
	return protocol.Literal("type", m.Type, "terminal:input")
}

// LogValue logs the input size, not the keystrokes. They may hold a typed
// password.
func (m *TerminalInput) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("type", m.Type),
		slog.Int("dataLength", len(m.Data)),
	)
}

// TerminalResize resizes the attached PTY.
type TerminalResize struct {
	Type string                `json:"type"`
	Size protocol.TerminalSize `json:"size"`
}

func (*TerminalResize) WireType() string { return "terminal:resize" }

func (m *TerminalResize) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "terminal:resize"),
		protocol.Nested("size", m.Size),
	)
}

// PaneList asks for the panes of the active window.
type PaneList struct {
	Type string `json:"type"`
}

func (*PaneList) WireType() string { return "pane:list" }

func (m *PaneList) Validate() error {
	return protocol.Literal("type", m.Type, "pane:list")
}

// PaneSplit splits the active pane. The new pane starts in its folder.
type PaneSplit struct {
	Type      string `json:"type"`
	Direction string `json:"direction"`
}

func (*PaneSplit) WireType() string { return "pane:split" }

func (m *PaneSplit) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "pane:split"),
		protocol.OneOf("direction", m.Direction, SplitDirections...),
	)
}

// PaneSelect focuses a pane and shows its window. ID is a tmux pane id
// such as "%3".
type PaneSelect struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (*PaneSelect) WireType() string { return "pane:select" }

func (m *PaneSelect) Validate() error {
	return protocol.Literal("type", m.Type, "pane:select")
}

// PaneZoom zooms a pane or unzooms the window. ID names the pane so the
// request cannot hit another one. Zoomed is the state wanted, so a repeat
// does nothing. Without both fields it toggles the active pane, as older
// clients expect.
type PaneZoom struct {
	Type   string  `json:"type"`
	ID     *string `json:"id,omitempty"`
	Zoomed *bool   `json:"zoomed,omitempty"`
}

func (*PaneZoom) WireType() string { return "pane:zoom" }

func (m *PaneZoom) Validate() error {
	return protocol.Literal("type", m.Type, "pane:zoom")
}

// PaneStep moves to the next or previous pane of the current window.
// Delta is relative, so a stale pane list cannot make it miss.
type PaneStep struct {
	Type  string `json:"type"`
	Delta int    `json:"delta"`
}

func (*PaneStep) WireType() string { return "pane:step" }

func (m *PaneStep) Validate() error {
	return protocol.Literal("type", m.Type, "pane:step")
}

// PaneResize grows a pane by Amount cells toward Direction.
type PaneResize struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Direction string `json:"direction"`
	Amount    int    `json:"amount"`
}

func (*PaneResize) WireType() string { return "pane:resize" }

func (m *PaneResize) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "pane:resize"),
		protocol.OneOf("direction", m.Direction, PaneDirections...),
		protocol.Min("amount", m.Amount, 1),
	)
}

// PaneKill kills a pane.
type PaneKill struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (*PaneKill) WireType() string { return "pane:kill" }

func (m *PaneKill) Validate() error {
	return protocol.Literal("type", m.Type, "pane:kill")
}

// PaneSwap swaps two panes. With Direction the pane swaps with its
// neighbour that way, as the mobile controls ask. With Target it swaps with
// that pane, which may sit in another window. Exactly one of the two is
// set.
type PaneSwap struct {
	Type      string  `json:"type"`
	ID        string  `json:"id"`
	Direction *string `json:"direction,omitempty"`
	Target    *string `json:"target,omitempty"`
}

func (*PaneSwap) WireType() string { return "pane:swap" }

func (m *PaneSwap) Validate() error {
	errs := []error{protocol.Literal("type", m.Type, "pane:swap")}
	if m.Direction != nil {
		errs = append(errs, protocol.OneOf("direction", *m.Direction, PaneDirections...))
	}
	// The same fields as the refinement on the Zod union.
	switch {
	case m.Direction == nil && m.Target == nil:
		errs = append(errs, &protocol.FieldError{Field: "direction", Reason: "set exactly one of direction or target"})
	case m.Direction != nil && m.Target != nil:
		errs = append(errs, &protocol.FieldError{Field: "target", Reason: "set exactly one of direction or target"})
	}
	return errors.Join(errs...)
}

// PaneJoin moves a pane into another window. It splits the active pane of
// WindowID, beside it for "h" and below it for "v". The moved pane becomes
// the active pane and its window the current one, as tmux does by default.
type PaneJoin struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	WindowID  string `json:"windowId"`
	Direction string `json:"direction"`
}

func (*PaneJoin) WireType() string { return "pane:join" }

func (m *PaneJoin) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "pane:join"),
		protocol.OneOf("direction", m.Direction, SplitDirections...),
	)
}

// PaneBreak moves a pane out into a new window of its session. The new
// window becomes the current one, as tmux does by default.
type PaneBreak struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (*PaneBreak) WireType() string { return "pane:break" }

func (m *PaneBreak) Validate() error {
	return protocol.Literal("type", m.Type, "pane:break")
}

// PaneCapture asks for a pane's contents as text.
type PaneCapture struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (*PaneCapture) WireType() string { return "pane:capture" }

func (m *PaneCapture) Validate() error {
	return protocol.Literal("type", m.Type, "pane:capture")
}

// TmuxPrefix sends the tmux prefix key.
type TmuxPrefix struct {
	Type string `json:"type"`
}

func (*TmuxPrefix) WireType() string { return "tmux:prefix" }

func (m *TmuxPrefix) Validate() error {
	return protocol.Literal("type", m.Type, "tmux:prefix")
}

// TmuxCopyMode enters copy mode.
type TmuxCopyMode struct {
	Type string `json:"type"`
}

func (*TmuxCopyMode) WireType() string { return "tmux:copy-mode" }

func (m *TmuxCopyMode) Validate() error {
	return protocol.Literal("type", m.Type, "tmux:copy-mode")
}

// TmuxScroll scrolls the active pane. Positive lines scroll up. Mouse aware
// apps get wheel events, other alternate screen apps get arrow keys, shell
// history and copy mode use tmux.
type TmuxScroll struct {
	Type  string `json:"type"`
	Lines int    `json:"lines"`
}

func (*TmuxScroll) WireType() string { return "tmux:scroll" }

func (m *TmuxScroll) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "tmux:scroll"),
		protocol.Between("lines", m.Lines, MinScrollLines, MaxScrollLines),
	)
}

// TmuxScrollTo jumps to Position lines above the live output, as tmux
// scroll_position counts. 0 is the bottom. The server moves the difference.
type TmuxScrollTo struct {
	Type     string `json:"type"`
	Position int    `json:"position"`
}

func (*TmuxScrollTo) WireType() string { return "tmux:scroll-to" }

func (m *TmuxScrollTo) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "tmux:scroll-to"),
		protocol.Min("position", m.Position, 0),
	)
}

// TmuxScrollState asks for the attached pane's scroll position. The answer
// is server.TmuxScrollState.
type TmuxScrollState struct {
	Type string `json:"type"`
}

func (*TmuxScrollState) WireType() string { return "tmux:scroll-state" }

func (m *TmuxScrollState) Validate() error {
	return protocol.Literal("type", m.Type, "tmux:scroll-state")
}

// TmuxExitCopyMode leaves copy mode so typing reaches the pane again.
type TmuxExitCopyMode struct {
	Type string `json:"type"`
}

func (*TmuxExitCopyMode) WireType() string { return "tmux:exit-copy-mode" }

func (m *TmuxExitCopyMode) Validate() error {
	return protocol.Literal("type", m.Type, "tmux:exit-copy-mode")
}

// CommandSend types a command into the attached PTY and presses Enter.
type CommandSend struct {
	Type    string `json:"type"`
	Command string `json:"command"`
}

func (*CommandSend) WireType() string { return "command:send" }

func (m *CommandSend) Validate() error {
	return protocol.Literal("type", m.Type, "command:send")
}

// LogValue logs the command size, not the command.
func (m *CommandSend) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("type", m.Type),
		slog.Int("commandLength", len(m.Command)),
	)
}

// CommandInterrupt sends Ctrl+C.
type CommandInterrupt struct {
	Type string `json:"type"`
}

func (*CommandInterrupt) WireType() string { return "command:interrupt" }

func (m *CommandInterrupt) Validate() error {
	return protocol.Literal("type", m.Type, "command:interrupt")
}

// CommandEOF sends Ctrl+D.
type CommandEOF struct {
	Type string `json:"type"`
}

func (*CommandEOF) WireType() string { return "command:eof" }

func (m *CommandEOF) Validate() error {
	return protocol.Literal("type", m.Type, "command:eof")
}

// CommandClear clears the screen.
type CommandClear struct {
	Type string `json:"type"`
}

func (*CommandClear) WireType() string { return "command:clear" }

func (m *CommandClear) Validate() error {
	return protocol.Literal("type", m.Type, "command:clear")
}

// CommandSuspend sends Ctrl+Z.
type CommandSuspend struct {
	Type string `json:"type"`
}

func (*CommandSuspend) WireType() string { return "command:suspend" }

func (m *CommandSuspend) Validate() error {
	return protocol.Literal("type", m.Type, "command:suspend")
}
