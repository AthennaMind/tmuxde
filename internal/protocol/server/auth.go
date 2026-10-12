package server

import (
	"errors"

	"tmuxde/internal/protocol"
)

var authTypes = map[string]func() Message{
	"auth:success": func() Message { return &AuthSuccess{} },
	"auth:failure": func() Message { return &AuthFailure{} },
	"pong":         func() Message { return &Pong{} },
	"error":        func() Message { return &Error{} },
	"server:info":  func() Message { return &ServerInfo{} },
}

// AuthSuccess answers a valid auth. Features lists message types the
// browser may use beyond the original set. An absent list reads as an older
// server.
type AuthSuccess struct {
	Type          string        `json:"type"`
	ServerVersion string        `json:"serverVersion"`
	Capabilities  *Capabilities `json:"capabilities,omitempty"`
	Features      []string      `json:"features,omitzero"`
}

func (*AuthSuccess) WireType() string { return "auth:success" }

func (m *AuthSuccess) Validate() error {
	err := protocol.Literal("type", m.Type, "auth:success")
	if m.Capabilities != nil {
		err = errors.Join(err, protocol.Nested("capabilities", m.Capabilities))
	}
	return err
}

// Capabilities is advisory. The server enforces access on every message.
// Scope is a plain string on purpose, so a new scope kind cannot break an
// older browser.
type Capabilities struct {
	ReadOnly bool   `json:"readOnly"`
	Files    string `json:"files"`
	Scope    string `json:"scope"`
}

func (c Capabilities) Validate() error {
	return protocol.OneOf("files", c.Files, "none", "read", "write")
}

// AuthFailure rejects auth. The socket closes after it.
type AuthFailure struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

func (*AuthFailure) WireType() string { return "auth:failure" }

func (m *AuthFailure) Validate() error {
	return protocol.Literal("type", m.Type, "auth:failure")
}

// Pong answers a ping with its timestamp.
type Pong struct {
	Type      string  `json:"type"`
	Timestamp float64 `json:"timestamp"`
}

func (*Pong) WireType() string { return "pong" }

func (m *Pong) Validate() error {
	return protocol.Literal("type", m.Type, "pong")
}

// Error reports a failed request. Code is a stable name such as
// INVALID_MESSAGE or RATE_LIMITED.
type Error struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (*Error) WireType() string { return "error" }

func (m *Error) Validate() error {
	return protocol.Literal("type", m.Type, "error")
}

// ServerInfo follows auth:success. Uptime is in seconds. DefaultPath is the
// directory the file browser opens first.
type ServerInfo struct {
	Type        string  `json:"type"`
	Hostname    string  `json:"hostname"`
	Platform    string  `json:"platform"`
	Uptime      float64 `json:"uptime"`
	DefaultPath *string `json:"defaultPath,omitempty"`
}

func (*ServerInfo) WireType() string { return "server:info" }

func (m *ServerInfo) Validate() error {
	return protocol.Literal("type", m.Type, "server:info")
}
