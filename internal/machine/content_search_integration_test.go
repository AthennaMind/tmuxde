//go:build integration

package machine

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

func TestIntegrationRemoteContentSearch(t *testing.T) {
	hub := NewHub(t.TempDir(), strings.Repeat("b", 32))
	site := httptest.NewTLSServer(hub)
	t.Cleanup(site.Close)
	t.Cleanup(hub.Close)
	for _, name := range []string{"alpha", "beta"} {
		n, root := realNode(t)
		if out, err := exec.Command("git", "-C", root, "init", "-q").CombinedOutput(); err != nil {
			t.Fatalf("git: %s %v", out, err)
		}
		if err := os.WriteFile(filepath.Join(root, "same.txt"), []byte("needle from "+name), 0600); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command("tmux", "-S", filepath.Join(root, "tmux.sock"), "new-session", "-d", "-s", "same", "-c", root).CombinedOutput(); err != nil {
			t.Fatalf("tmux: %s %v", out, err)
		}
		record, _, _ := startAgent(t, hub, site, n, name)
		remote, _, _, _, err := hub.Resolve(record.ID)
		if err != nil {
			t.Fatal(err)
		}
		sink := make(messageSink, 32)
		if err := remote.Open(t.Context(), 1, sink); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { remote.Close(1) })
		if err := remote.Handle(t.Context(), 1, &client.SessionAttach{Type: "session:attach", Name: "same", Size: &protocol.TerminalSize{Cols: 80, Rows: 24}}); err != nil {
			t.Fatal(err)
		}
		receive(t, sink, "session:attached")
		query := "needle"
		if err := remote.Handle(t.Context(), 1, &client.RepoRequest{Type: "repo:request", RequestID: "same-request", ID: "%0", Action: "content-search", Query: &query}); err != nil {
			t.Fatal(err)
		}
		reply := receive(t, sink, "repo:result").(*server.RepoResult)
		result, ok := reply.Result.(*protocol.RepoContentSearch)
		if !ok {
			t.Fatalf("%s result: %+v", name, reply.Result)
		}
		if reply.RequestID != "same-request" || result.Root != root || len(result.Matches) != 1 || result.Matches[0].Preview != "needle from "+name {
			t.Fatalf("%s crossed machines: %+v", name, result)
		}
	}
}
