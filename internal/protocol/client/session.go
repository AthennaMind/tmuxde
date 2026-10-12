package client

import (
	"errors"

	"tmuxde/internal/protocol"
)

var sessionTypes = map[string]func() Message{
	"session:list":    func() Message { return &SessionList{} },
	"session:create":  func() Message { return &SessionCreate{} },
	"session:attach":  func() Message { return &SessionAttach{} },
	"session:detach":  func() Message { return &SessionDetach{} },
	"session:kill":    func() Message { return &SessionKill{} },
	"session:rename":  func() Message { return &SessionRename{} },
	"session:windows": func() Message { return &SessionWindows{} },
	"window:list":     func() Message { return &WindowList{} },
	"window:create":   func() Message { return &WindowCreate{} },
	"window:select":   func() Message { return &WindowSelect{} },
	"window:step":     func() Message { return &WindowStep{} },
	"window:kill":     func() Message { return &WindowKill{} },
	"window:rename":   func() Message { return &WindowRename{} },
	"window:layout":   func() Message { return &WindowLayout{} },
	"layout:rotate":   func() Message { return &LayoutRotate{} },
}

// LayoutPresets are the values of WindowLayout.Preset.
var LayoutPresets = []string{
	"even-horizontal",
	"even-vertical",
	"main-horizontal",
	"main-vertical",
	"tiled",
}

// SessionList asks for every tmux session.
type SessionList struct {
	Type string `json:"type"`
}

func (*SessionList) WireType() string { return "session:list" }

func (m *SessionList) Validate() error {
	return protocol.Literal("type", m.Type, "session:list")
}

// SessionCreate makes a new session. Every field is optional. The server
// picks a name and folder when they are absent.
type SessionCreate struct {
	Type    string  `json:"type"`
	Name    *string `json:"name,omitempty"`
	Cwd     *string `json:"cwd,omitempty"`
	Command *string `json:"command,omitempty"`
}

func (*SessionCreate) WireType() string { return "session:create" }

func (m *SessionCreate) Validate() error {
	return protocol.Literal("type", m.Type, "session:create")
}

// SessionAttach attaches the connection to a session. Capture asks for the
// current screen first. AttachID is an attach epoch that comes back on
// session:attached, so the browser can drop the answer to an older attach.
type SessionAttach struct {
	Type     string                 `json:"type"`
	Name     string                 `json:"name"`
	Size     *protocol.TerminalSize `json:"size,omitempty"`
	Capture  *bool                  `json:"capture,omitempty"`
	AttachID *string                `json:"attachId,omitempty"`
}

func (*SessionAttach) WireType() string { return "session:attach" }

func (m *SessionAttach) Validate() error {
	err := protocol.Literal("type", m.Type, "session:attach")
	if m.Size != nil {
		err = errors.Join(err, protocol.Nested("size", m.Size))
	}
	return err
}

// SessionDetach detaches from the current session. The session keeps
// running.
type SessionDetach struct {
	Type string `json:"type"`
}

func (*SessionDetach) WireType() string { return "session:detach" }

func (m *SessionDetach) Validate() error {
	return protocol.Literal("type", m.Type, "session:detach")
}

// SessionKill kills a session by name.
type SessionKill struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

func (*SessionKill) WireType() string { return "session:kill" }

func (m *SessionKill) Validate() error {
	return protocol.Literal("type", m.Type, "session:kill")
}

// SessionRename renames a session.
type SessionRename struct {
	Type    string `json:"type"`
	OldName string `json:"oldName"`
	NewName string `json:"newName"`
}

func (*SessionRename) WireType() string { return "session:rename" }

func (m *SessionRename) Validate() error {
	return protocol.Literal("type", m.Type, "session:rename")
}

// SessionWindows asks for the windows and panes of one session.
type SessionWindows struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

func (*SessionWindows) WireType() string { return "session:windows" }

func (m *SessionWindows) Validate() error {
	return protocol.Literal("type", m.Type, "session:windows")
}

// WindowList asks for the windows of the attached session.
type WindowList struct {
	Type string `json:"type"`
}

func (*WindowList) WireType() string { return "window:list" }

func (m *WindowList) Validate() error {
	return protocol.Literal("type", m.Type, "window:list")
}

// WindowCreate opens a window in the attached session. Name is optional.
type WindowCreate struct {
	Type string  `json:"type"`
	Name *string `json:"name,omitempty"`
}

func (*WindowCreate) WireType() string { return "window:create" }

func (m *WindowCreate) Validate() error {
	return protocol.Literal("type", m.Type, "window:create")
}

// WindowSelect focuses a window by tmux id, such as "@3".
type WindowSelect struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (*WindowSelect) WireType() string { return "window:select" }

func (m *WindowSelect) Validate() error {
	return protocol.Literal("type", m.Type, "window:select")
}

// WindowStep moves to the next or previous window and wraps. Delta is
// signed and has no range in the schema.
type WindowStep struct {
	Type  string `json:"type"`
	Delta int    `json:"delta"`
}

func (*WindowStep) WireType() string { return "window:step" }

func (m *WindowStep) Validate() error {
	return protocol.Literal("type", m.Type, "window:step")
}

// WindowKill kills a window by tmux id.
type WindowKill struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (*WindowKill) WireType() string { return "window:kill" }

func (m *WindowKill) Validate() error {
	return protocol.Literal("type", m.Type, "window:kill")
}

// WindowRename renames a window by tmux id.
type WindowRename struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (*WindowRename) WireType() string { return "window:rename" }

func (m *WindowRename) Validate() error {
	return protocol.Literal("type", m.Type, "window:rename")
}

// WindowLayout applies a tmux layout preset to the active window.
type WindowLayout struct {
	Type   string `json:"type"`
	Preset string `json:"preset"`
}

func (*WindowLayout) WireType() string { return "window:layout" }

func (m *WindowLayout) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "window:layout"),
		protocol.OneOf("preset", m.Preset, LayoutPresets...),
	)
}

// LayoutRotate rotates the panes of the active window.
type LayoutRotate struct {
	Type string `json:"type"`
}

func (*LayoutRotate) WireType() string { return "layout:rotate" }

func (m *LayoutRotate) Validate() error {
	return protocol.Literal("type", m.Type, "layout:rotate")
}
