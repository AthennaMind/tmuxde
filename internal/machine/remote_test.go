package machine

import (
	"slices"
	"strings"
	"testing"

	"tmuxde/internal/protocol"
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

func TestAgentBaselineFrameBudget(t *testing.T) {
	root, content := "/repo", strings.Repeat("a\tb\n", 100)
	msg := &server.RepoResult{
		Type: "repo:result", RequestID: "editor",
		Result: &protocol.RepoBaseline{Kind: "baseline", Root: &root, Content: &content},
	}
	full, err := server.Encode(msg)
	if err != nil {
		t.Fatal(err)
	}
	for _, limit := range []int{len(full), len(full) - 1} {
		frame, err := encodeAgentMessage(msg, limit)
		if err != nil || len(frame) > limit {
			t.Fatalf("frame length %d, limit %d, error %v", len(frame), limit, err)
		}
		decoded, err := server.Decode(frame)
		if err != nil {
			t.Fatal(err)
		}
		reply := decoded.(*server.RepoResult)
		got := reply.Result.(*protocol.RepoBaseline)
		if reply.RequestID != msg.RequestID || got.Root == nil || *got.Root != root || (got.Content != nil) != (limit == len(full)) {
			t.Fatalf("unexpected baseline for frame budget %d", limit)
		}
	}
}
