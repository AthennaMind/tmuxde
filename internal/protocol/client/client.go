// Package client holds the messages a browser sends, one struct per wire
// type. They mirror ui/src/protocol/client-messages.ts and RepoRequest
// in repository.ts. See package protocol for the rules.
package client

import "tmuxde/internal/protocol"

// Message is a decoded client message.
type Message interface {
	WireType() string
	Validate() error
}

// Decode reads and validates one client message. Errors match
// protocol.ErrNotObject, ErrNoType, ErrUnknownType or ErrInvalid.
func Decode(data []byte) (Message, error) {
	return protocol.Decode(data, registry)
}
