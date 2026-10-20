package machine

import (
	"slices"
	"testing"

	"tmuxde/internal/protocol/server"
)

// TestHubOwnedTypes pins which server types an agent may never relay to
// a browser. A new hub owned type must be added here and to hubOwned.
func TestHubOwnedTypes(t *testing.T) {
	want := []string{
		"auth:failure", "auth:success",
		"dictation:done", "dictation:error", "dictation:ready", "dictation:text",
		"pong", "server:info", "settings:changed",
	}
	var got []string
	for _, kind := range server.Types() {
		if hubOwned(kind) {
			got = append(got, kind)
		}
	}
	if !slices.Equal(got, want) {
		t.Fatalf("hub owned types = %v, want %v", got, want)
	}
}
