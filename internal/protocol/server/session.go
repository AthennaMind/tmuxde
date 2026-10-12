package server

import (
	"errors"

	"tmuxde/internal/protocol"
)

var sessionTypes = map[string]func() Message{
	"session:list":     func() Message { return &SessionList{} },
	"session:created":  func() Message { return &SessionCreated{} },
	"session:killed":   func() Message { return &SessionKilled{} },
	"session:activity": func() Message { return &SessionActivity{} },
	"session:exited":   func() Message { return &SessionExited{} },
	"session:attached": func() Message { return &SessionAttached{} },
	"session:windows":  func() Message { return &SessionWindows{} },
	"window:list":      func() Message { return &WindowList{} },
	"window:changed":   func() Message { return &WindowChanged{} },
}

// SessionList answers session:list with every visible session.
type SessionList struct {
	Type     string                 `json:"type"`
	Sessions []protocol.SessionInfo `json:"sessions"`
}

func (*SessionList) WireType() string { return "session:list" }

func (m *SessionList) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "session:list"),
		protocol.RequiredSlice("sessions", m.Sessions),
		protocol.Each("sessions", m.Sessions),
	)
}

// SessionCreated reports a new session.
type SessionCreated struct {
	Type    string               `json:"type"`
	Session protocol.SessionInfo `json:"session"`
}

func (*SessionCreated) WireType() string { return "session:created" }

func (m *SessionCreated) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "session:created"),
		protocol.Nested("session", m.Session),
	)
}

// SessionKilled reports a killed session by name.
type SessionKilled struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

func (*SessionKilled) WireType() string { return "session:killed" }

func (m *SessionKilled) Validate() error {
	return protocol.Literal("type", m.Type, "session:killed")
}

// SessionActivity carries a new activity timestamp for a session. Activity
// is an ISO timestamp as a string.
type SessionActivity struct {
	Type     string `json:"type"`
	Name     string `json:"name"`
	Activity string `json:"activity"`
}

func (*SessionActivity) WireType() string { return "session:activity" }

func (m *SessionActivity) Validate() error {
	return protocol.Literal("type", m.Type, "session:activity")
}

// SessionExited reports that a session ended. The attached connection gets
// the exit code of its attach process. Other connections learn from the
// session monitor and get no code. ExitCode is a pointer so exit code 0
// survives a round trip.
type SessionExited struct {
	Type     string   `json:"type"`
	Name     string   `json:"name"`
	ExitCode *float64 `json:"exitCode,omitempty"`
}

func (*SessionExited) WireType() string { return "session:exited" }

func (m *SessionExited) Validate() error {
	return protocol.Literal("type", m.Type, "session:exited")
}

// SessionAttached acknowledges session:attach. AttachID echoes the attach
// epoch the browser sent, when it sent one.
type SessionAttached struct {
	Type     string  `json:"type"`
	Name     string  `json:"name"`
	AttachID *string `json:"attachId,omitempty"`
}

func (*SessionAttached) WireType() string { return "session:attached" }

func (m *SessionAttached) Validate() error {
	return protocol.Literal("type", m.Type, "session:attached")
}

// SessionWindows answers session:windows with the windows and panes of one
// session.
type SessionWindows struct {
	Type    string                `json:"type"`
	Name    string                `json:"name"`
	Windows []protocol.WindowInfo `json:"windows"`
	Panes   []protocol.PaneInfo   `json:"panes"`
}

func (*SessionWindows) WireType() string { return "session:windows" }

func (m *SessionWindows) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "session:windows"),
		protocol.RequiredSlice("windows", m.Windows),
		protocol.Each("windows", m.Windows),
		protocol.RequiredSlice("panes", m.Panes),
		protocol.Each("panes", m.Panes),
	)
}

// WindowList answers window:list with the windows of the attached session.
type WindowList struct {
	Type        string                `json:"type"`
	Windows     []protocol.WindowInfo `json:"windows"`
	SessionName string                `json:"sessionName"`
}

func (*WindowList) WireType() string { return "window:list" }

func (m *WindowList) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "window:list"),
		protocol.RequiredSlice("windows", m.Windows),
		protocol.Each("windows", m.Windows),
	)
}

// WindowChanged pushes the window set of a session after it changed.
type WindowChanged struct {
	Type        string                `json:"type"`
	Windows     []protocol.WindowInfo `json:"windows"`
	SessionName string                `json:"sessionName"`
}

func (*WindowChanged) WireType() string { return "window:changed" }

func (m *WindowChanged) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "window:changed"),
		protocol.RequiredSlice("windows", m.Windows),
		protocol.Each("windows", m.Windows),
	)
}
