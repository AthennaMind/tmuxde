package client

import (
	"log/slog"

	"tmuxde/internal/protocol"
)

var authTypes = map[string]func() Message{
	"auth": func() Message { return &Auth{} },
	"ping": func() Message { return &Ping{} },
}

// Auth must be the first message on a connection.
type Auth struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

func (*Auth) WireType() string { return "auth" }

func (m *Auth) Validate() error {
	return protocol.Literal("type", m.Type, "auth")
}

// LogValue keeps the token out of logs.
func (m *Auth) LogValue() slog.Value {
	return slog.GroupValue(slog.String("type", m.Type), slog.String("token", "[redacted]"))
}

// Ping asks for a pong. Timestamp is the client clock in milliseconds and
// comes back unchanged.
type Ping struct {
	Type      string  `json:"type"`
	Timestamp float64 `json:"timestamp"`
}

func (*Ping) WireType() string { return "ping" }

func (m *Ping) Validate() error {
	return protocol.Literal("type", m.Type, "ping")
}
