//go:build integration

package local

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"

	"tmuxde/internal/node/files"
	"tmuxde/internal/node/repo"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// TestIntegrationRepoWatchRealService runs repo:watch through the real repository
// service on a temp repository: a write arrives as repo:changed, and
// closing the connection stops the watch.
func TestIntegrationRepoWatchRealService(t *testing.T) {
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Fatal("git not installed")
	}
	root := realDir(t)
	t.Setenv("HOME", root)
	cmd := exec.Command(gitBin, "init", "-q", root)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	guard, err := files.NewGuard([]string{root}, root, "")
	if err != nil {
		t.Fatal(err)
	}
	h := newHarnessWith(t, func(d *Deps) {
		d.Files = files.New(guard, files.Options{Logger: quiet})
		d.Repo = repo.New(guard, repo.Options{Logger: quiet})
	})
	sink := h.open(1)
	h.setAttached(1, "work")
	h.tm.set(func(f *fakeTmux) { f.panes = []protocol.PaneInfo{paneAt("%1", root)} })
	h.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1"})
	wantWatchResult(t, sink, root, true, false, "")

	writeFile(t, filepath.Join(root, "hello.txt"), "x")
	sink.waitFor(func(m []server.Message) bool {
		return slices.ContainsFunc(m, func(msg server.Message) bool {
			c, ok := msg.(*server.RepoChanged)
			return ok && c.Root == root && slices.Contains(c.Paths, "hello.txt")
		})
	})
	c := h.conn(1)
	h.n.Close(1)
	if n := repoWatchCount(c); n != 0 {
		t.Fatalf("watches after Close = %d", n)
	}
}
