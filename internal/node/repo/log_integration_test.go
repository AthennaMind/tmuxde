//go:build integration

package repo

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
)

// TestIntegrationRepositoryHistory ports repository-log.test.ts. The cases share one
// repository and run in order, as in the relay.
func TestIntegrationRepositoryHistory(t *testing.T) {
	base := tempBase(t)
	root := filepath.Join(base, "repo")
	mustMkdir(t, filepath.Join(root, "secret"))
	git := newGit(t, filepath.Join(base, "home"))
	hashes := map[string]string{}
	commit := func(name string, args ...string) {
		git.run(root, append([]string{"commit", "-q", "-m", name}, args...)...)
		hashes[name] = strings.TrimSpace(git.run(root, "rev-parse", "HEAD"))
	}
	git.init(root, "-b", "main")
	mustWrite(t, filepath.Join(root, "a.txt"), "one\ntwo\nthree\nfour\n")
	mustWrite(t, filepath.Join(root, "secret", "key"), "hidden\n")
	git.run(root, "add", ".")
	commit("root")
	git.run(root, "mv", "a.txt", "b.txt")
	mustWrite(t, filepath.Join(root, "b.txt"), "one\ntwo\nthree\nfive\n")
	mustWrite(t, filepath.Join(root, "bin.dat"), "\x00\x01\x02\x00")
	git.run(root, "add", ".")
	commit("rename", "-m", "Body line one.\n\nBody line two.")
	git.run(root, "switch", "-q", "-c", "side")
	mustWrite(t, filepath.Join(root, "side.txt"), "side\n")
	git.run(root, "add", ".")
	commit("side")
	git.run(root, "switch", "-q", "main")
	mustWrite(t, filepath.Join(root, "main.txt"), "main\n")
	git.run(root, "add", ".")
	commit("main")
	git.run(root, "merge", "-q", "--no-ff", "side", "-m", "merge")
	hashes["merge"] = strings.TrimSpace(git.run(root, "rev-parse", "HEAD"))
	for i := range 100 {
		git.run(root, "commit", "-q", "--allow-empty", "-m", "empty "+strconv.Itoa(i))
	}
	git.run(root, "tag", "v1")
	// A branch not merged into main, plus commits only a remote branch and
	// a tag reach. Only the all walk sees them.
	git.run(root, "switch", "-q", "-c", "topic", hashes["rename"])
	commit("topic", "--allow-empty")
	git.run(root, "switch", "-q", "main")
	tree := strings.TrimSpace(git.run(root, "rev-parse", hashes["root"]+"^{tree}"))
	hashes["remote"] = strings.TrimSpace(git.run(root, "commit-tree", tree, "-p", hashes["root"], "-m", "remote"))
	git.run(root, "update-ref", "refs/remotes/origin/gone", hashes["remote"])
	hashes["tagged"] = strings.TrimSpace(git.run(root, "commit-tree", tree, "-m", "tagged"))
	git.run(root, "tag", "loose", hashes["tagged"])

	// File policy denies the server's own config folder. It points inside
	// the repository so one committed file there must stay out of view.
	s := newService(newTestGuard(t, []string{base}, []string{filepath.Join(root, "secret")}), Options{})
	show := func(t *testing.T, cwd string, commit *string) protocol.RepoResult {
		t.Helper()
		return request(t, s, cwd, client.RepoRequest{Action: "show", Commit: commit})
	}

	t.Run("pages the log from HEAD", func(t *testing.T) {
		first := as[*protocol.RepoLog](t, request(t, s, root, client.RepoRequest{Action: "log"}))
		if deref(first.Root) != root || deref(first.Branch) != "main" || first.Skip != 0 || !first.More {
			t.Fatalf("first page = root %v branch %v skip %v more %v", first.Root, first.Branch, first.Skip, first.More)
		}
		if len(first.Commits) != 100 {
			t.Fatalf("first page has %d commits, want 100", len(first.Commits))
		}
		top := first.Commits[0]
		if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(top.Hash) || top.Author != "Test" || top.Subject != "empty 99" {
			t.Errorf("top commit = %+v", top)
		}
		if want := []string{"HEAD -> main", "tag: v1"}; !slices.Equal(top.Refs, want) {
			t.Errorf("refs = %q, want %q", top.Refs, want)
		}
		if _, err := time.Parse(time.RFC3339, top.Date); err != nil {
			t.Errorf("date %q: %v", top.Date, err)
		}
		second := as[*protocol.RepoLog](t, request(t, s, root, client.RepoRequest{Action: "log", Skip: ptr(100)}))
		if second.Skip != 100 || second.More {
			t.Fatalf("second page = skip %v more %v", second.Skip, second.More)
		}
		var subjects []string
		for _, c := range second.Commits {
			subjects = append(subjects, c.Subject)
		}
		if want := []string{"merge", "main", "side", "rename", "root"}; !slices.Equal(subjects, want) {
			t.Fatalf("subjects = %q, want %q", subjects, want)
		}
		if want := []string{hashes["main"], hashes["side"]}; !slices.Equal(second.Commits[0].Parents, want) {
			t.Errorf("merge parents = %q, want %q", second.Commits[0].Parents, want)
		}
		if p := second.Commits[4].Parents; p == nil || len(p) != 0 {
			t.Errorf("root parents = %#v, want an empty list", p)
		}
	})

	t.Run("pages every branch, tag and remote with all", func(t *testing.T) {
		head := as[*protocol.RepoLog](t, request(t, s, root, client.RepoRequest{Action: "log", Skip: ptr(100)}))
		for _, c := range head.Commits {
			if c.Subject == "topic" || c.Subject == "remote" || c.Subject == "tagged" {
				t.Fatalf("HEAD page has %q", c.Subject)
			}
		}
		first := as[*protocol.RepoLog](t, request(t, s, root, client.RepoRequest{Action: "log", All: ptr(true)}))
		if len(first.Commits) != 100 || !first.More || deref(first.Branch) != "main" {
			t.Fatalf("first page = %d commits, more %v, branch %v", len(first.Commits), first.More, first.Branch)
		}
		second := as[*protocol.RepoLog](t, request(t, s, root, client.RepoRequest{Action: "log", All: ptr(true), Skip: ptr(100)}))
		if second.Skip != 100 || second.More {
			t.Fatalf("second page = skip %v more %v", second.Skip, second.More)
		}
		commits := append(slices.Clone(first.Commits), second.Commits...)
		if len(commits) != 108 {
			t.Fatalf("all pages have %d commits, want 108", len(commits))
		}
		// Paging continues the order of one long walk, Git's default order
		// by commit date. Every reachable commit comes once.
		var got []string
		seen := map[string]bool{}
		for _, c := range commits {
			if seen[c.Hash] {
				t.Errorf("%q comes twice", c.Subject)
			}
			seen[c.Hash] = true
			got = append(got, c.Hash)
		}
		want := strings.Fields(git.run(root, "log", "--branches", "--tags", "--remotes", "--format=%H", "HEAD"))
		if !slices.Equal(got, want) {
			t.Fatalf("all order differs from git log --branches --tags --remotes HEAD")
		}
		reachable := strings.Fields(git.run(root, "rev-list", "--branches", "--tags", "--remotes", "HEAD"))
		if len(reachable) != len(commits) {
			t.Fatalf("rev-list has %d commits, pages %d", len(reachable), len(commits))
		}
		for _, h := range reachable {
			if !seen[h] {
				t.Errorf("commit %s is missing", h[:7])
			}
		}
		refs := map[string][]string{}
		for _, c := range commits {
			refs[c.Subject] = c.Refs
		}
		for subject, want := range map[string][]string{
			"topic":    {"topic"},
			"remote":   {"origin/gone"},
			"tagged":   {"tag: loose"},
			"empty 99": {"HEAD -> main", "tag: v1"},
		} {
			if !slices.Equal(refs[subject], want) {
				t.Errorf("refs of %q = %q, want %q", subject, refs[subject], want)
			}
		}
	})

	t.Run("answers an empty history before the first commit and outside Git", func(t *testing.T) {
		fresh := filepath.Join(base, "fresh")
		mustMkdir(t, fresh)
		git.init(fresh, "-b", "main")
		got := as[*protocol.RepoLog](t, request(t, s, fresh, client.RepoRequest{Action: "log"}))
		want := &protocol.RepoLog{Kind: "log", Root: &fresh, Branch: ptr("main"), Skip: 0, Commits: []protocol.RepoCommit{}, More: false}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("log = %+v, want %+v", got, want)
		}
		if all := as[*protocol.RepoLog](t, request(t, s, fresh, client.RepoRequest{Action: "log", All: ptr(true)})); !reflect.DeepEqual(all, want) {
			t.Fatalf("log all = %+v, want %+v", all, want)
		}
		plain := filepath.Join(base, "plain")
		mustMkdir(t, plain)
		outside := as[*protocol.RepoLog](t, request(t, s, plain, client.RepoRequest{Action: "log"}))
		if outside.Root != nil || outside.Commits == nil || len(outside.Commits) != 0 {
			t.Fatalf("log outside Git = %+v", outside)
		}
	})

	t.Run("shows a root commit and hides files denied by policy", func(t *testing.T) {
		got := as[*protocol.RepoShow](t, show(t, root, ptr(hashes["root"][:7])))
		c := got.Commit
		if c.Hash != hashes["root"] || len(c.Parents) != 0 || c.Parents == nil || c.Email != "test@example.invalid" || c.Subject != "root" || c.Body != "" {
			t.Errorf("commit = %+v", c)
		}
		if got.Hidden != 1 || got.Truncated {
			t.Errorf("hidden %v truncated %v, want 1 and false", got.Hidden, got.Truncated)
		}
		if len(got.Files) != 1 {
			t.Fatalf("files = %+v, want only a.txt", got.Files)
		}
		f := got.Files[0]
		if f.Path != "a.txt" || f.OriginalPath != nil || f.Status != "A" || val(f.Additions) != 4 || f.Deletions == nil || *f.Deletions != 0 || f.Binary {
			t.Errorf("file = %+v", f)
		}
		if !regexp.MustCompile(`(?s)^diff --git a/a.txt b/a.txt\n.*\+four$`).MatchString(f.Patch) {
			t.Errorf("patch = %q", f.Patch)
		}
	})

	t.Run("shows renames, binary files and the body", func(t *testing.T) {
		got := as[*protocol.RepoShow](t, show(t, root, ptr(hashes["rename"])))
		if got.Commit.Body != "Body line one.\n\nBody line two." {
			t.Errorf("body = %q", got.Commit.Body)
		}
		if len(got.Files) != 2 {
			t.Fatalf("files = %+v, want two", got.Files)
		}
		renamed, binary := got.Files[0], got.Files[1]
		if renamed.Path != "b.txt" || deref(renamed.OriginalPath) != "a.txt" || renamed.Status != "R" ||
			val(renamed.Additions) != 1 || val(renamed.Deletions) != 1 || !strings.Contains(renamed.Patch, "-four\n+five") {
			t.Errorf("rename = %+v", renamed)
		}
		if binary.Path != "bin.dat" || binary.Status != "A" || binary.Additions != nil || !binary.Binary {
			t.Errorf("binary = %+v", binary)
		}
	})

	t.Run("shows a merge against its first parent", func(t *testing.T) {
		got := as[*protocol.RepoShow](t, show(t, root, ptr(hashes["merge"])))
		if len(got.Commit.Parents) != 2 {
			t.Errorf("parents = %q, want two", got.Commit.Parents)
		}
		var paths []string
		for _, f := range got.Files {
			paths = append(paths, f.Path)
		}
		if !slices.Equal(paths, []string{"side.txt"}) {
			t.Errorf("files = %q, want side.txt", paths)
		}
	})

	t.Run("refuses malformed and unknown commits", func(t *testing.T) {
		tests := []struct {
			commit *string
			want   string
		}{
			{ptr("HEAD~1"), "Invalid commit"},
			{ptr("0000000"), "Commit not found"},
			{nil, "Commit required"},
		}
		for _, tt := range tests {
			if got := errorText(t, show(t, root, tt.commit)); got != tt.want {
				t.Errorf("show %v = %q, want %q", deref(tt.commit), got, tt.want)
			}
		}
	})

	t.Run("turns off signature checks that run the configured program", func(t *testing.T) {
		signed := filepath.Join(base, "signed")
		mustMkdir(t, signed)
		git.init(signed, "-b", "main")
		marker := filepath.Join(base, "gpg-ran")
		program := filepath.Join(base, "gpg.sh")
		if err := os.WriteFile(program, []byte("#!/bin/sh\ntouch "+marker+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		git.run(signed, "commit", "-q", "--allow-empty", "-m", "unsigned")
		// A commit object carrying a signature header, so verification
		// would run.
		tree := strings.TrimSpace(git.run(signed, "rev-parse", "HEAD^{tree}"))
		parent := strings.TrimSpace(git.run(signed, "rev-parse", "HEAD"))
		object := strings.Join([]string{
			"tree " + tree,
			"parent " + parent,
			"author Test <test@example.invalid> 1700000000 +0000",
			"committer Test <test@example.invalid> 1700000000 +0000",
			"gpgsig -----BEGIN PGP SIGNATURE-----",
			" ",
			" AAAA",
			" -----END PGP SIGNATURE-----",
			"",
			"signed",
			"",
		}, "\n")
		hash := strings.TrimSpace(git.runInput(signed, object, "hash-object", "-t", "commit", "-w", "--stdin"))
		git.run(signed, "update-ref", "refs/heads/main", hash)
		git.run(signed, "config", "log.showSignature", "true")
		git.run(signed, "config", "gpg.program", program)

		// Git either runs the program or, where temp folders refuse to
		// execute, reports that it tried. Both count as an attempt.
		attempted := func(args ...string) bool {
			t.Helper()
			if err := os.Remove(marker); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			_, stderr, _ := git.try(signed, "", args...)
			_, statErr := os.Stat(marker)
			return statErr == nil || strings.Contains(stderr, program)
		}
		// Control: the fixture does trigger a check without the flags.
		if !attempted("log", "-1", "--format=%s") {
			t.Fatal("control: plain log did not try to verify the signature")
		}
		if attempted(append(append([]string{"log"}, historyFlags...), "-1", "--format=%s")...) {
			t.Error("log with history flags tried to verify the signature")
		}
		if attempted(append(append([]string{"show", "-s"}, historyFlags...), "--format=%s", hash)...) {
			t.Error("show with history flags tried to verify the signature")
		}

		log := as[*protocol.RepoLog](t, request(t, s, signed, client.RepoRequest{Action: "log"}))
		if len(log.Commits) == 0 || log.Commits[0].Subject != "signed" {
			t.Fatalf("log = %+v", log.Commits)
		}
		as[*protocol.RepoShow](t, show(t, signed, ptr(hash)))
		missing(t, marker)
	})
}
