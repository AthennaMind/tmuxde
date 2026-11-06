//go:build integration

package repo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
)

func TestIntegrationChangedFileMutations(t *testing.T) {
	base := tempBase(t)
	root := filepath.Join(base, "repo")
	mustMkdir(t, root)
	git := newGit(t, filepath.Join(base, "home"))
	git.init(root)
	for _, name := range []string{"both.txt", "other.txt", "deleted.txt", "old.txt"} {
		mustWrite(t, filepath.Join(root, name), "base\n")
	}
	git.run(root, "add", ".")
	git.run(root, "commit", "-qm", "fixture")
	s := newService(newTestGuard(t, []string{root}, nil), Options{})
	mutate := func(action, name, scope string) protocol.RepoResult {
		return request(t, s, root, client.RepoRequest{Action: action, File: ptr(name), Scope: ptr(scope)})
	}
	read := func(name string) string {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}

	t.Run("stage only selected file", func(t *testing.T) {
		mustWrite(t, filepath.Join(root, "both.txt"), "staged\n")
		mustWrite(t, filepath.Join(root, "other.txt"), "keep\n")
		as[*protocol.RepoStatus](t, mutate("stage", "both.txt", "unstaged"))
		if got := git.run(root, "diff", "--cached", "--name-only"); got != "both.txt\n" {
			t.Fatalf("staged %q", got)
		}
	})
	t.Run("discard worktree preserves staged version", func(t *testing.T) {
		mustWrite(t, filepath.Join(root, "both.txt"), "working\n")
		as[*protocol.RepoStatus](t, mutate("discard", "both.txt", "unstaged"))
		if read("both.txt") != "staged\n" || git.run(root, "show", ":both.txt") != "staged\n" || read("other.txt") != "keep\n" {
			t.Fatal("discard changed wrong version or file")
		}
	})
	t.Run("unstage keeps worktree", func(t *testing.T) {
		mustWrite(t, filepath.Join(root, "both.txt"), "working\n")
		as[*protocol.RepoStatus](t, mutate("unstage", "both.txt", "staged"))
		if read("both.txt") != "working\n" || git.run(root, "diff", "--cached", "--name-only") != "" {
			t.Fatal("unstage lost work or index entries")
		}
	})
	t.Run("restore deleted file", func(t *testing.T) {
		if err := os.Remove(filepath.Join(root, "deleted.txt")); err != nil {
			t.Fatal(err)
		}
		as[*protocol.RepoStatus](t, mutate("discard", "deleted.txt", "unstaged"))
		if read("deleted.txt") != "base\n" {
			t.Fatal("deleted file not restored")
		}
	})
	t.Run("delete only selected untracked file with literal name", func(t *testing.T) {
		name := ":(glob)*\n.txt"
		mustWrite(t, filepath.Join(root, name), "remove\n")
		mustWrite(t, filepath.Join(root, "keep.txt"), "keep\n")
		as[*protocol.RepoStatus](t, mutate("stage", name, "untracked"))
		as[*protocol.RepoStatus](t, mutate("unstage", name, "staged"))
		as[*protocol.RepoStatus](t, mutate("discard", name, "untracked"))
		if _, err := os.Lstat(filepath.Join(root, name)); !os.IsNotExist(err) {
			t.Fatalf("file remains: %v", err)
		}
		if read("keep.txt") != "keep\n" {
			t.Fatal("untracked sibling removed")
		}
	})
	t.Run("unstage both rename paths", func(t *testing.T) {
		git.run(root, "mv", "old.txt", "new.txt")
		as[*protocol.RepoStatus](t, mutate("unstage", "new.txt", "staged"))
		if read("new.txt") != "base\n" || strings.Contains(git.run(root, "ls-files"), "new.txt") || !strings.Contains(git.run(root, "ls-files"), "old.txt") {
			t.Fatal("rename unstage changed worktree or left index rename")
		}
	})
	t.Run("reject staged discard and stale groups", func(t *testing.T) {
		for _, scope := range []string{"staged", "untracked"} {
			as[*protocol.RepoError](t, mutate("discard", "both.txt", scope))
		}
		if read("both.txt") != "working\n" {
			t.Fatal("refused discard changed content")
		}
	})
	t.Run("deny traversal metadata directories and symlinks", func(t *testing.T) {
		outside := filepath.Join(base, "outside.txt")
		mustWrite(t, outside, "safe\n")
		mustSymlink(t, outside, filepath.Join(root, "link.txt"))
		mustMkdir(t, filepath.Join(root, "folder"))
		for _, name := range []string{"../outside.txt", outside, ".", ".git/config", "folder", "link.txt", "x/../both.txt"} {
			as[*protocol.RepoError](t, mutate("discard", name, "untracked"))
		}
		if data, _ := os.ReadFile(outside); string(data) != "safe\n" {
			t.Fatal("outside file changed")
		}
	})
	t.Run("refuse unmerged files without changing content or index", func(t *testing.T) {
		name := "conflict.txt"
		mustWrite(t, filepath.Join(root, name), "keep conflict\n")
		hash := strings.TrimSpace(git.runInput(root, "base\n", "hash-object", "-w", "--stdin"))
		git.runInput(root, "100644 "+hash+" 1\t"+name+"\n100644 "+hash+" 2\t"+name+"\n100644 "+hash+" 3\t"+name+"\n", "update-index", "--index-info")
		before := git.run(root, "ls-files", "--unmerged")
		for _, action := range []string{"stage", "unstage", "discard"} {
			scope := "unstaged"
			if action == "unstage" {
				scope = "staged"
			}
			as[*protocol.RepoError](t, mutate(action, name, scope))
		}
		if read(name) != "keep conflict\n" || git.run(root, "ls-files", "--unmerged") != before {
			t.Fatal("conflict data changed")
		}
	})
}

func TestIntegrationUnstageBeforeFirstCommit(t *testing.T) {
	base := tempBase(t)
	root := filepath.Join(base, "repo")
	mustMkdir(t, root)
	git := newGit(t, filepath.Join(base, "home"))
	git.init(root)
	mustWrite(t, filepath.Join(root, "new.txt"), "new\n")
	s := newService(newTestGuard(t, []string{root}, nil), Options{})
	for _, action := range []string{"stage", "unstage"} {
		scope := "untracked"
		if action == "unstage" {
			scope = "staged"
		}
		as[*protocol.RepoStatus](t, request(t, s, root, client.RepoRequest{Action: action, File: ptr("new.txt"), Scope: ptr(scope)}))
	}
	if git.run(root, "ls-files") != "" {
		t.Fatal("file still staged")
	}
	if data, err := os.ReadFile(filepath.Join(root, "new.txt")); err != nil || string(data) != "new\n" {
		t.Fatal("unstage changed file")
	}
}
