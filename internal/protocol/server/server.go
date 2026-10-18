// Package server holds the messages the server sends, one struct per wire
// type. They mirror ui/src/protocol/server-messages.ts and
// RepoResponse in repository.ts. See package protocol for the rules.
package server

import "tmuxde/internal/protocol"

// Message is a server message.
type Message interface {
	WireType() string
	Validate() error
}

// Decode reads and validates one server message. The server only sends
// these. Decode exists for tests and fixtures.
func Decode(data []byte) (Message, error) {
	return protocol.Decode(data, registry)
}

// Encode validates and marshals a server message.
func Encode(msg Message) ([]byte, error) {
	return protocol.Encode(msg)
}
