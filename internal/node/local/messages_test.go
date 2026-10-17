package local

import (
	"tmuxde/internal/protocol/server"
)

func hasType(wireType string) func([]server.Message) bool {
	return func(m []server.Message) bool { return indexOf(m, wireType) >= 0 }
}

func indexOf(msgs []server.Message, wireType string) int {
	for i, m := range msgs {
		if m.WireType() == wireType {
			return i
		}
	}
	return -1
}
