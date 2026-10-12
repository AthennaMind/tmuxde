package repo

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
)

// statusKey flattens an entry for comparison.
type statusKey struct{ path, original, index, worktree string }

func statusKeys(entries []protocol.RepoStatusEntry) []statusKey {
	keys := make([]statusKey, 0, len(entries))
	for _, e := range entries {
		keys = append(keys, statusKey{e.Path, deref(e.OriginalPath), e.Index, e.Worktree})
	}
	return keys
}

// TestRepositoryReads ports repository-service.test.ts. The cases share
// one repository and run in order, as in the relay.
func TestRepositoryReads(t *testing.T) {
	base := tempBase(t)
	root := filepath.Join(base, "repo")
	mustMkdir(t, root)
	git := newGit(t, filepath.Join(base, "home"))
	git.init(root)
	mustWrite(t, filepath.Join(root, "both.txt"), "base\n")
	mustWrite(t, filepath.Join(root, "delete.txt"), "removed\n")
	mustWrite(t, filepath.Join(root, "old name.txt"), "renamed\n")
	git.run(root, "add", ".")
	git.run(root, "commit", "-q", "-m", "fixture")
	mustWrite(t, filepath.Join(root, "both.txt"), "staged\n")
	git.run(root, "add", "both.txt")
	mustWrite(t, filepath.Join(root, "both.txt"), "working\n")
	if err := os.Remove(filepath.Join(root, "delete.txt")); err != nil {
		t.Fatal(err)
	}
	git.run(root, "mv", "old name.txt", "new name.txt")
	mustWrite(t, filepath.Join(root, ":(glob)*\n.txt"), "new file\n")

	s := newService(newTestGuard(t, []string{root}, nil), Options{})
	diff := func(t *testing.T, cwd, file, scope string) protocol.RepoResult {
		t.Helper()
		return request(t, s, cwd, client.RepoRequest{Action: "diff", File: ptr(file), Scope: ptr(scope)})
	}

	t.Run("reports staged, unstaged, renamed and unusual untracked names", func(t *testing.T) {
		result := as[*protocol.RepoStatus](t, request(t, s, root, client.RepoRequest{Action: "status"}))
		if result.Root == nil || *result.Root != root {
			t.Fatalf("root = %v, want %s", result.Root, root)
		}
		got := statusKeys(result.Entries)
		for _, want := range []statusKey{
			{"both.txt", "", "M", "M"},
			{"delete.txt", "", " ", "D"},
			{"new name.txt", "old name.txt", "R", " "},
			{":(glob)*\n.txt", "", "?", "?"},
		} {
			if !slices.Contains(got, want) {
				t.Errorf("entries %q lack %q", got, want)
			}
		}
	})

	t.Run("separates staged and unstaged diffs", func(t *testing.T) {
		staged := as[*protocol.RepoDiff](t, diff(t, root, "both.txt", "staged"))
		unstaged := as[*protocol.RepoDiff](t, diff(t, root, "both.txt", "unstaged"))
		if !strings.Contains(staged.Content, "+staged") {
			t.Errorf("staged diff lacks +staged:\n%s", staged.Content)
		}
		if !strings.Contains(unstaged.Content, "+working") {
			t.Errorf("unstaged diff lacks +working:\n%s", unstaged.Content)
		}
	})

	t.Run("handles deleted and literal untracked paths", func(t *testing.T) {
		deleted := as[*protocol.RepoDiff](t, diff(t, root, "delete.txt", "unstaged"))
		if !strings.Contains(deleted.Content, "-removed") {
			t.Errorf("deleted diff lacks -removed:\n%s", deleted.Content)
		}
		untracked := as[*protocol.RepoDiff](t, diff(t, root, ":(glob)*\n.txt", "untracked"))
		if !strings.Contains(untracked.Content, "+new file") {
			t.Errorf("untracked diff lacks +new file:\n%s", untracked.Content)
		}
	})

	t.Run("rejects traversal and symlinks outside allowed paths", func(t *testing.T) {
		mustWrite(t, filepath.Join(base, "secret"), "secret")
		mustSymlink(t, filepath.Join(base, "secret"), filepath.Join(root, "escape"))
		wantError(t, request(t, s, root, client.RepoRequest{Action: "read", Path: ptr(filepath.Join(root, "escape"))}), `(?i)denied`)
		wantError(t, diff(t, root, "../secret", "unstaged"), `(?i)denied`)
	})

	t.Run("bounds text reads and detects binary files", func(t *testing.T) {
		mustWrite(t, filepath.Join(root, "large.txt"), strings.Repeat("x", 200_000))
		mustWrite(t, filepath.Join(root, "binary.dat"), "\x00\x01\x02")
		large := as[*protocol.RepoRead](t, request(t, s, root, client.RepoRequest{Action: "read", Path: ptr(filepath.Join(root, "large.txt"))}))
		if !large.Truncated {
			t.Error("large read not truncated")
		}
		binary := as[*protocol.RepoRead](t, request(t, s, root, client.RepoRequest{Action: "read", Path: ptr(filepath.Join(root, "binary.dat"))}))
		if !binary.Binary || binary.Content != "" {
			t.Errorf("binary read = binary %v content %q", binary.Binary, binary.Content)
		}
	})

	t.Run("returns a clear non-repository context", func(t *testing.T) {
		outside := filepath.Join(root, "plain")
		mustMkdir(t, outside)
		if err := os.Rename(filepath.Join(root, ".git"), filepath.Join(root, "saved-git")); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := os.Rename(filepath.Join(root, "saved-git"), filepath.Join(root, ".git")); err != nil {
				t.Fatal(err)
			}
		}()
		got := as[*protocol.RepoContext](t, request(t, s, outside, client.RepoRequest{Action: "context"}))
		want := protocol.RepoContext{Kind: "context", Path: outside}
		if *got != want {
			t.Fatalf("context = %+v, want %+v", *got, want)
		}
	})

	t.Run("rejects Git metadata symlink escapes before invoking Git", func(t *testing.T) {
		linked := filepath.Join(root, "linked")
		mustMkdir(t, linked)
		mustSymlink(t, filepath.Join(base, "secret"), filepath.Join(linked, ".git"))
		wantError(t, request(t, s, linked, client.RepoRequest{Action: "context"}), `(?i)denied`)
	})

	t.Run("supports staged changes before first commit", func(t *testing.T) {
		unborn := filepath.Join(root, "unborn")
		mustMkdir(t, unborn)
		git.run(unborn, "init", "-q")
		mustWrite(t, filepath.Join(unborn, "first.txt"), "first\n")
		git.run(unborn, "add", ".")
		got := as[*protocol.RepoDiff](t, diff(t, unborn, "first.txt", "staged"))
		if !strings.Contains(got.Content, "+first") {
			t.Fatalf("diff lacks +first:\n%s", got.Content)
		}
	})

	t.Run("does not execute fsmonitor, external diff or textconv programs", func(t *testing.T) {
		marker := filepath.Join(root, "executed")
		command := "touch " + marker
		git.run(root, "config", "core.fsmonitor", command)
		git.run(root, "config", "diff.external", command)
		git.run(root, "config", "diff.unsafe.textconv", command)
		mustWrite(t, filepath.Join(root, ".gitattributes"), "both.txt diff=unsafe\n")
		defer func() {
			git.run(root, "config", "--unset", "core.fsmonitor")
			git.run(root, "config", "--unset", "diff.external")
			git.run(root, "config", "--unset", "diff.unsafe.textconv")
			if err := os.Remove(filepath.Join(root, ".gitattributes")); err != nil {
				t.Fatal(err)
			}
		}()
		as[*protocol.RepoStatus](t, request(t, s, root, client.RepoRequest{Action: "status"}))
		as[*protocol.RepoDiff](t, diff(t, root, "both.txt", "unstaged"))
		missing(t, marker)
	})

	t.Run("rejects Git pointers and nested metadata escaping allow list", func(t *testing.T) {
		pointer := filepath.Join(root, "pointer")
		mustMkdir(t, pointer)
		mustWrite(t, filepath.Join(pointer, ".git"), "gitdir: "+base+"\n")
		wantError(t, request(t, s, pointer, client.RepoRequest{Action: "context"}), `(?i)denied`)
		link := filepath.Join(root, ".git", "objects", "escape")
		mustSymlink(t, base, link)
		defer func() {
			if err := os.Remove(link); err != nil {
				t.Fatal(err)
			}
		}()
		wantError(t, request(t, s, root, client.RepoRequest{Action: "context"}), `(?i)denied`)
	})

	t.Run("supports linked worktrees within allowed paths", func(t *testing.T) {
		worktree := filepath.Join(root, "worktree")
		git.run(root, "worktree", "add", "--detach", worktree)
		got := as[*protocol.RepoContext](t, request(t, s, worktree, client.RepoRequest{Action: "context"}))
		if got.Root == nil || *got.Root != worktree || got.Branch != nil {
			t.Fatalf("context = root %v branch %v, want %s and no branch", got.Root, got.Branch, worktree)
		}
	})

	t.Run("bounds Git diff output", func(t *testing.T) {
		large := filepath.Join(root, "large-diff.txt")
		mustWrite(t, large, "baseline\n")
		git.run(root, "add", "large-diff.txt")
		mustWrite(t, large, strings.Repeat("changed line\n", 80_000))
		got := as[*protocol.RepoDiff](t, diff(t, root, "large-diff.txt", "unstaged"))
		if !got.Truncated {
			t.Error("diff not truncated")
		}
		if len(got.Content) > 512*1024 {
			t.Errorf("diff is %d bytes, over 512 KiB", len(got.Content))
		}
	})

	t.Run("detects binary Git diffs", func(t *testing.T) {
		binary := filepath.Join(root, "tracked.dat")
		mustWrite(t, binary, "\x00\x01\x02")
		git.run(root, "add", "tracked.dat")
		mustWrite(t, binary, "\x00\x03\x04")
		if got := as[*protocol.RepoDiff](t, diff(t, root, "tracked.dat", "unstaged")); !got.Binary {
			t.Fatalf("diff not binary:\n%s", got.Content)
		}
	})

	t.Run("rejects configured clean filters before Git can execute them", func(t *testing.T) {
		marker := filepath.Join(root, "filter-ran")
		git.run(root, "config", "filter.unsafe.clean", "touch "+marker+"; cat")
		mustWrite(t, filepath.Join(root, ".gitattributes"), "both.txt filter=unsafe\n")
		defer func() {
			git.run(root, "config", "--unset", "filter.unsafe.clean")
			if err := os.Remove(filepath.Join(root, ".gitattributes")); err != nil {
				t.Fatal(err)
			}
		}()
		wantError(t, diff(t, root, "both.txt", "unstaged"), `filters are unsupported`)
		missing(t, marker)
	})

	t.Run("builds accurate untracked patches with and without final newline", func(t *testing.T) {
		file := filepath.Join(root, "untracked-content.txt")
		tests := []struct {
			content, want string
			exact         bool
		}{
			{"one\ntwo\n", "@@ -0,0 +1,2 @@\n+one\n+two\n", false},
			{"one", "@@ -0,0 +1,1 @@\n+one\n\\ No newline at end of file\n", false},
			{"", "", true},
		}
		for _, tt := range tests {
			mustWrite(t, file, tt.content)
			got := as[*protocol.RepoDiff](t, diff(t, root, file, "untracked"))
			if tt.exact && got.Content != tt.want || !strings.Contains(got.Content, tt.want) {
				t.Errorf("patch for %q = %q, want %q", tt.content, got.Content, tt.want)
			}
		}
	})

	t.Run("keeps selected repository context when pane changes directory", func(t *testing.T) {
		got := as[*protocol.RepoStatus](t, request(t, s, filepath.Join(root, "unborn"), client.RepoRequest{Action: "status", Path: ptr(root)}))
		if got.Root == nil || *got.Root != root {
			t.Fatalf("root = %v, want %s", got.Root, root)
		}
	})
}
