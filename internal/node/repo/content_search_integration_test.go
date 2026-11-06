//go:build integration

package repo

import (
	"path/filepath"
	"testing"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
)

func TestIntegrationContentSearch(t *testing.T) {
	base := tempBase(t)
	root := filepath.Join(base, "repo")
	mustMkdir(t, filepath.Join(root, "src"))
	git := newGit(t, filepath.Join(base, "home"))
	git.init(root)
	mustWrite(t, filepath.Join(root, "tracked.go"), "old")
	git.run(root, "add", "tracked.go")
	mustWrite(t, filepath.Join(root, "tracked.go"), "needle from disk")
	mustWrite(t, filepath.Join(root, ".gitignore"), "ignored.go\n")
	mustWrite(t, filepath.Join(root, "ignored.go"), "needle")
	mustWrite(t, filepath.Join(root, "src", "new.go"), "needle")
	mustWrite(t, filepath.Join(root, "secret.go"), "needle")
	s := newService(newTestGuard(t, []string{root}, []string{filepath.Join(root, "secret.go")}), Options{})
	result := as[*protocol.RepoContentSearch](t, request(t, s, filepath.Join(root, "src"), client.RepoRequest{Action: "content-search", Query: ptr("needle")}))
	if result.Root != root || result.Truncated || len(result.Matches) != 2 || result.Matches[0].Path != "src/new.go" || result.Matches[1].Preview != "needle from disk" {
		t.Fatalf("search: %+v", result)
	}
	result = as[*protocol.RepoContentSearch](t, request(t, s, root, client.RepoRequest{Action: "content-search", Query: ptr("needle"), Include: ptr("*.go"), Exclude: ptr("src/**")}))
	if len(result.Matches) != 1 || result.Matches[0].Path != "tracked.go" {
		t.Fatalf("filtered: %+v", result)
	}
	// Ignore rules must not hide a file already tracked by Git.
	git.run(root, "add", "-f", "ignored.go")
	result = as[*protocol.RepoContentSearch](t, request(t, s, root, client.RepoRequest{Action: "content-search", Query: ptr("needle")}))
	if len(result.Matches) != 3 {
		t.Fatalf("tracked ignored: %+v", result)
	}
}
