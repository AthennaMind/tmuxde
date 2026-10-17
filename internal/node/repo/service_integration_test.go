//go:build integration

package repo

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
)

// committedRepo makes base/repo with both.txt committed, then staged and
// changed again in the work tree.
func committedRepo(t *testing.T, base string) (string, *gitRunner) {
	t.Helper()
	root := filepath.Join(base, "repo")
	mustMkdir(t, root)
	git := newGit(t, filepath.Join(base, "home"))
	git.init(root, "-b", "main")
	mustWrite(t, filepath.Join(root, "both.txt"), "base\n")
	git.run(root, "add", ".")
	git.run(root, "commit", "-q", "-m", "first")
	mustWrite(t, filepath.Join(root, "both.txt"), "staged\n")
	git.run(root, "add", ".")
	mustWrite(t, filepath.Join(root, "both.txt"), "working\n")
	return root, git
}

// fakeGit puts an executable named git first on PATH.
func fakeGit(t *testing.T, base, script string) {
	t.Helper()
	dir := filepath.Join(base, "bin")
	mustMkdir(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

// Port note 1: the relay took a killed Git for exit code 0. Where 0 was
// accepted, a timeout answered with empty output as if all was well.
func TestIntegrationGitTimeoutIsAnError(t *testing.T) {
	base := tempBase(t)
	root, _ := committedRepo(t, base)
	// sleep runs as a child, so the pipe outlives the shell unless the
	// whole process group is killed.
	fakeGit(t, base, "#!/bin/sh\nsleep 30\n")
	s := newService(newTestGuard(t, []string{base}, nil), Options{Timeout: 300 * time.Millisecond})

	tests := []struct {
		name string
		req  client.RepoRequest
	}{
		{"context, where exit codes 0 and 1 count as success", client.RepoRequest{Action: "context"}},
		{"status", client.RepoRequest{Action: "status"}},
		{"log", client.RepoRequest{Action: "log"}},
		{"diff", client.RepoRequest{Action: "diff", File: ptr("both.txt"), Scope: ptr("unstaged")}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			start := time.Now()
			if got := errorText(t, request(t, s, root, tt.req)); got != "Git request timed out" {
				t.Fatalf("error = %q, want Git request timed out", got)
			}
			// Without the group kill, sleep keeps the pipe open until
			// waitDelay closes it.
			if elapsed := time.Since(start); elapsed >= s.opts.Timeout+waitDelay-100*time.Millisecond {
				t.Fatalf("request took %v, the group kill did not end the pipe", elapsed)
			}
		})
	}
}

// Port note 11: a rename record whose original path the output cap cut
// off is dropped, not shown without its original.
func TestIntegrationStatusDropsPartialRecordAfterTruncation(t *testing.T) {
	base := tempBase(t)
	root := filepath.Join(base, "repo")
	mustMkdir(t, root)
	git := newGit(t, filepath.Join(base, "home"))
	git.init(root, "-b", "main")
	mustWrite(t, filepath.Join(root, "a.txt"), "rename me\n")
	mustWrite(t, filepath.Join(root, "c.txt"), "change me\n")
	git.run(root, "add", ".")
	git.run(root, "commit", "-q", "-m", "first")
	git.run(root, "mv", "a.txt", "b.txt")
	mustWrite(t, filepath.Join(root, "c.txt"), "changed\n")
	// Full output, 24 bytes: "R  b.txt\0a.txt\0 M c.txt\0".
	g := newTestGuard(t, []string{base}, nil)
	renamed := statusKey{"b.txt", "a.txt", "R", " "}
	changed := statusKey{"c.txt", "", " ", "M"}

	tests := []struct {
		limit     int
		want      []statusKey
		truncated bool
	}{
		{9, []statusKey{}, true},
		{13, []statusKey{}, true},
		{15, []statusKey{renamed}, true},
		{18, []statusKey{renamed}, true},
		{24, []statusKey{renamed, changed}, false},
	}
	for _, tt := range tests {
		s := newService(g, Options{OutputLimit: tt.limit})
		got := as[*protocol.RepoStatus](t, request(t, s, root, client.RepoRequest{Action: "status"}))
		if keys := statusKeys(got.Entries); !slices.Equal(keys, tt.want) || got.Truncated != tt.truncated {
			t.Errorf("limit %d: entries %q truncated %v, want %q %v", tt.limit, keys, got.Truncated, tt.want, tt.truncated)
		}
	}
}

// TestIntegrationGitInvocation checks every Git argv byte for byte, the working
// directory and the environment, through a wrapper that logs and then
// runs the real Git.
func TestIntegrationGitInvocation(t *testing.T) {
	base := tempBase(t)
	root, git := committedRepo(t, base)
	hash := strings.TrimSpace(git.run(root, "rev-parse", "HEAD"))
	calls := filepath.Join(base, "calls")
	envFile := filepath.Join(base, "env")
	fakeGit(t, base, "#!/bin/sh\n"+
		"{ printf 'cwd=%s' \"$(pwd -P)\"; for a in \"$@\"; do printf '\\037%s' \"$a\"; done; printf '\\036'; } >> "+calls+"\n"+
		"env > "+envFile+"\n"+
		"exec "+git.bin+" \"$@\"\n")
	// None of these may reach Git.
	t.Setenv("GIT_DIR", filepath.Join(base, "elsewhere"))
	t.Setenv("GIT_WORK_TREE", filepath.Join(base, "elsewhere"))
	t.Setenv("AUTH_TOKEN", "test-token-not-for-git")
	t.Setenv("LC_ALL", "C.UTF-8")
	s := newService(newTestGuard(t, []string{base}, nil), Options{})

	prefix := []string{
		"--no-pager", "--git-dir", filepath.Join(root, ".git"), "--work-tree", root,
		"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false",
		"-c", "protocol.allow=never", "-c", "diff.submodule=short", "-c", "core.quotePath=true",
	}
	branch := []string{"symbolic-ref", "--quiet", "--short", "HEAD"}
	file := filepath.Join(root, "both.txt")
	tests := []struct {
		name string
		req  client.RepoRequest
		want [][]string
	}{
		{"context", client.RepoRequest{Action: "context"}, [][]string{branch}},
		{"status", client.RepoRequest{Action: "status"}, [][]string{
			{"status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"},
			branch,
		}},
		{"unstaged diff", client.RepoRequest{Action: "diff", File: ptr("both.txt"), Scope: ptr("unstaged")}, [][]string{
			{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--ignore-submodules=all", "--", file},
		}},
		{"staged diff", client.RepoRequest{Action: "diff", File: ptr("both.txt"), Scope: ptr("staged")}, [][]string{
			{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--ignore-submodules=all", "--cached", "--", file},
		}},
		{"untracked diff", client.RepoRequest{Action: "diff", File: ptr("both.txt"), Scope: ptr("untracked")}, nil},
		{"log", client.RepoRequest{Action: "log", Skip: ptr(3)}, [][]string{
			branch,
			{"rev-parse", "--verify", "-q", "HEAD"},
			{"log", "--no-show-signature", "--no-mailmap", "--no-notes", "--no-color", "-z",
				"--format=%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s", "--max-count=101", "--skip=3", "--end-of-options", "HEAD"},
		}},
		{"log all", client.RepoRequest{Action: "log", Skip: ptr(3), All: ptr(true)}, [][]string{
			branch,
			{"rev-parse", "--verify", "-q", "HEAD"},
			{"log", "--no-show-signature", "--no-mailmap", "--no-notes", "--no-color", "-z",
				"--format=%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s", "--max-count=101", "--skip=3",
				"--branches", "--tags", "--remotes", "--end-of-options", "HEAD"},
		}},
		{"log all false", client.RepoRequest{Action: "log", All: ptr(false)}, [][]string{
			branch,
			{"rev-parse", "--verify", "-q", "HEAD"},
			{"log", "--no-show-signature", "--no-mailmap", "--no-notes", "--no-color", "-z",
				"--format=%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s", "--max-count=101", "--skip=0", "--end-of-options", "HEAD"},
		}},
		{"show", client.RepoRequest{Action: "show", Commit: ptr(hash[:7])}, [][]string{
			{"rev-parse", "--verify", "-q", hash[:7] + "^{commit}"},
			{"show", "-s", "--no-show-signature", "--no-mailmap", "--no-notes", "--no-color",
				"--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%D%x1f%s%x1f%b", "--end-of-options", hash},
			{"diff-tree", "-r", "-z", "-M", "--root", "--raw", "--numstat", "-p", "--no-commit-id", "--no-abbrev",
				"--diff-merges=first-parent", "--no-ext-diff", "--no-textconv", "--no-color", "--end-of-options", hash},
		}},
		{"read", client.RepoRequest{Action: "read", Path: ptr("both.txt")}, nil},
		{"list", client.RepoRequest{Action: "list"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := os.Remove(calls); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			if r, ok := request(t, s, root, tt.req).(*protocol.RepoError); ok {
				t.Fatalf("error %q", r.Message)
			}
			data, err := os.ReadFile(calls)
			if err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			var got [][]string
			for _, call := range strings.Split(string(data), "\x1e") {
				if call == "" {
					continue
				}
				fields := strings.Split(call, "\x1f")
				if fields[0] != "cwd="+root {
					t.Errorf("git ran in %q, want %s", fields[0], root)
				}
				got = append(got, fields[1:])
			}
			var want [][]string
			for _, args := range tt.want {
				want = append(want, append(slices.Clone(prefix), args...))
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("git calls\n got %q\nwant %q", got, want)
			}
		})
	}

	data, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatal(err)
	}
	var gitVars []string
	for _, kv := range strings.Split(string(data), "\n") {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "GIT_") || k == "LC_ALL" || k == "AUTH_TOKEN" {
			gitVars = append(gitVars, kv)
		}
	}
	slices.Sort(gitVars)
	want := []string{
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_LITERAL_PATHSPECS=1",
		"GIT_NO_LAZY_FETCH=1",
		"GIT_NO_REPLACE_OBJECTS=1",
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0",
		"LC_ALL=C",
	}
	if !slices.Equal(gitVars, want) {
		t.Fatalf("Git environment\n got %q\nwant %q", gitVars, want)
	}
}

// Git starts a section right after the "]" of another one on the same
// line. The relay pattern only looked at line starts.
func TestIntegrationConfigIncludesAndFilters(t *testing.T) {
	base := tempBase(t)
	root, git := committedRepo(t, base)
	config := filepath.Join(root, ".git", "config")
	orig, err := os.ReadFile(config)
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(root, ".git", "extra"), "[tmuxde]\n\tprobe = included\n")

	// Control: Git does read an include that follows another section.
	mustWrite(t, config, string(orig)+"[core] [include]\n\tpath = extra\n")
	if got := strings.TrimSpace(git.run(root, "config", "--get", "tmuxde.probe")); got != "included" {
		t.Fatalf("control: tmuxde.probe = %q, Git ignored the include", got)
	}

	s := newService(newTestGuard(t, []string{base}, nil), Options{})
	tests := []struct {
		name, config string
		refused      bool
	}{
		{"include at a line start", "[include]\n\tpath = extra\n", true},
		{"include in upper case after spaces", "  [ Include ]\n\tpath = extra\n", true},
		{"include after a byte order mark", "\ufeff[include]\n\tpath = extra\n", true},
		{"include after a section on the same line", "[core] [include]\n\tpath = extra\n", true},
		{"includeIf right after a section", "[core][includeIf \"gitdir:/\"]\n\tpath = extra\n", true},
		{"filter after a tab", "[core]\t[filter \"x\"]\n\tclean = cat\n", true},
		{"filter in dotted form", "[filter.x]\n\tclean = cat\n", true},
		{"include after a carriage return", "[core]\r[include]\n\tpath = extra\n", true},
		{"include in a comment", "# [include]\n", false},
		{"include in a value", "[alias]\n\tx = !echo include filter\n", false},
		{"section that only starts with include", "[includes]\n\tx = 1\n", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mustWrite(t, config, string(orig)+tt.config)
			defer mustWrite(t, config, string(orig))
			got := request(t, s, root, client.RepoRequest{Action: "context"})
			if tt.refused {
				if msg := errorText(t, got); msg != "Access denied: Git configuration includes and filters are unsupported" {
					t.Fatalf("error = %q", msg)
				}
				return
			}
			as[*protocol.RepoContext](t, got)
		})
	}
}

func TestIntegrationErrorMessages(t *testing.T) {
	base := tempBase(t)
	root, _ := committedRepo(t, base)
	plain := filepath.Join(base, "plain")
	mustMkdir(t, plain)
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := newService(newTestGuard(t, []string{base}, nil), Options{})

	tests := []struct {
		name string
		cwd  string
		req  client.RepoRequest
		want string
	}{
		{"pane outside allowed paths", outside, client.RepoRequest{Action: "context"}, "Access denied: path outside allowed directories"},
		{"empty pane directory", "", client.RepoRequest{Action: "context"}, "Access denied: path outside allowed directories"},
		{"relative pane directory", "repo", client.RepoRequest{Action: "context"}, "Access denied: path outside allowed directories"},
		{"path outside allowed paths", root, client.RepoRequest{Action: "status", Path: ptr(outside)}, "Access denied: path outside allowed directories"},
		{"read without path", root, client.RepoRequest{Action: "read"}, "File path required"},
		{"read of a directory", root, client.RepoRequest{Action: "read", Path: ptr(".git")}, "Not a regular file"},
		{"read of a missing file", root, client.RepoRequest{Action: "read", Path: ptr("gone.txt")}, "No such file or directory"},
		{"read below a file", root, client.RepoRequest{Action: "read", Path: ptr("both.txt/x")}, "Not a directory"},
		{"list of a file", root, client.RepoRequest{Action: "list", Path: ptr("both.txt")}, "Not a directory"},
		{"status of a file", root, client.RepoRequest{Action: "status", Path: ptr("both.txt")}, "Not a directory"},
		{"status of a missing directory", root, client.RepoRequest{Action: "status", Path: ptr("gone")}, "No such file or directory"},
		{"diff outside Git", plain, client.RepoRequest{Action: "diff", File: ptr("x"), Scope: ptr("staged")}, "Current pane directory is not a Git repository"},
		{"show outside Git", plain, client.RepoRequest{Action: "show", Commit: ptr("abcdef0")}, "Current pane directory is not a Git repository"},
		{"diff without scope", root, client.RepoRequest{Action: "diff", File: ptr("both.txt")}, "File and change scope required"},
		{"diff without file", root, client.RepoRequest{Action: "diff", Scope: ptr("staged")}, "File and change scope required"},
		{"diff with unknown scope", root, client.RepoRequest{Action: "diff", File: ptr("both.txt"), Scope: ptr("all")}, "File and change scope required"},
		{"diff outside the repository", root, client.RepoRequest{Action: "diff", File: ptr("../plain/x"), Scope: ptr("staged")}, "Access denied: file outside repository"},
		{"show of a ref name", root, client.RepoRequest{Action: "show", Commit: ptr("HEAD")}, "Invalid commit"},
		{"show of an option", root, client.RepoRequest{Action: "show", Commit: ptr("--all")}, "Invalid commit"},
		{"negative skip", root, client.RepoRequest{Action: "log", Skip: ptr(-1)}, "Invalid skip"},
		{"unknown action", root, client.RepoRequest{Action: "push"}, "Unknown repository action"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := errorText(t, request(t, s, tt.cwd, tt.req)); got != tt.want {
				t.Fatalf("error = %q, want %q", got, tt.want)
			}
		})
	}

	t.Run("request id is echoed on errors", func(t *testing.T) {
		res := s.Request(t.Context(), "", &client.RepoRequest{Type: "repo:request", RequestID: "abc", ID: "%1", Action: "context"})
		if res.RequestID != "abc" || res.Result.RepoKind() != "error" {
			t.Fatalf("result = %+v", res)
		}
		if got := ErrorResult("r9", "Pane not found"); got.RequestID != "r9" || errorText(t, got.Result) != "Pane not found" {
			t.Fatalf("ErrorResult = %+v", got)
		}
	})
}

func TestIntegrationGitMetadataRefusals(t *testing.T) {
	base := tempBase(t)
	root, _ := committedRepo(t, base)
	s := newService(newTestGuard(t, []string{base}, nil), Options{})
	pointer := filepath.Join(base, "pointer")
	mustMkdir(t, pointer)

	tests := []struct {
		name  string
		setup func(t *testing.T) (cwd string, undo func())
		want  string
	}{
		{"pointer without gitdir prefix", func(t *testing.T) (string, func()) {
			mustWrite(t, filepath.Join(pointer, ".git"), "nonsense\n")
			return pointer, func() {}
		}, "Invalid Git directory pointer"},
		{"pointer over two lines", func(t *testing.T) (string, func()) {
			mustWrite(t, filepath.Join(pointer, ".git"), "gitdir: "+filepath.Join(root, ".git")+"\nmore\n")
			return pointer, func() {}
		}, "Invalid Git directory pointer"},
		{"pointer over the read limit", func(t *testing.T) (string, func()) {
			mustWrite(t, filepath.Join(pointer, ".git"), "gitdir: "+strings.Repeat("a", 102400))
			return pointer, func() {}
		}, "Unsupported Git metadata"},
		{"binary pointer", func(t *testing.T) (string, func()) {
			mustWrite(t, filepath.Join(pointer, ".git"), "gitdir: \x00")
			return pointer, func() {}
		}, "Unsupported Git metadata"},
		{"object alternates", func(t *testing.T) (string, func()) {
			file := filepath.Join(root, ".git", "objects", "info", "alternates")
			mustWrite(t, file, filepath.Join(base, "objects")+"\n")
			return root, func() { os.Remove(file) }
		}, "Access denied: Git object alternates are unsupported"},
		{"http alternates", func(t *testing.T) (string, func()) {
			file := filepath.Join(root, ".git", "objects", "info", "http-alternates")
			mustWrite(t, file, "https://example.invalid/objects\n")
			return root, func() { os.Remove(file) }
		}, "Access denied: Git object alternates are unsupported"},
		{"commondir outside allowed paths", func(t *testing.T) (string, func()) {
			file := filepath.Join(root, ".git", "commondir")
			mustWrite(t, file, "/\n")
			return root, func() { os.Remove(file) }
		}, "Access denied: path outside allowed directories"},
		{"metadata symlink inside allowed paths", func(t *testing.T) (string, func()) {
			link := filepath.Join(root, ".git", "refs", "link")
			mustSymlink(t, root, link)
			return root, func() { os.Remove(link) }
		}, "Access denied: Git metadata symlinks are unsupported"},
		{"config that is a FIFO", func(t *testing.T) (string, func()) {
			fifo := filepath.Join(root, ".git", "refs", "config")
			if err := syscall.Mkfifo(fifo, 0o644); err != nil {
				t.Fatal(err)
			}
			return root, func() { os.Remove(fifo) }
		}, "Not a regular file"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cwd, undo := tt.setup(t)
			defer undo()
			if got := errorText(t, request(t, s, cwd, client.RepoRequest{Action: "context"})); got != tt.want {
				t.Fatalf("error = %q, want %q", got, tt.want)
			}
		})
	}

	t.Run("blank alternates and hooks or logs are fine", func(t *testing.T) {
		file := filepath.Join(root, ".git", "objects", "info", "alternates")
		mustWrite(t, file, "\n  \n")
		defer os.Remove(file)
		link := filepath.Join(root, ".git", "hooks", "link")
		mustSymlink(t, base, link)
		defer os.Remove(link)
		got := as[*protocol.RepoContext](t, request(t, s, root, client.RepoRequest{Action: "context"}))
		if deref(got.Root) != root || deref(got.Branch) != "main" {
			t.Fatalf("context = %+v", got)
		}
	})

	t.Run("inspection stops at the deadline", func(t *testing.T) {
		hurried := newService(newTestGuard(t, []string{base}, nil), Options{Timeout: time.Nanosecond})
		if got := errorText(t, request(t, hurried, root, client.RepoRequest{Action: "context"})); got != "Git metadata exceeds inspection limit" {
			t.Fatalf("error = %q", got)
		}
	})
}

// TestIntegrationConcurrentRequests runs requests in parallel on one service, for
// the race detector.
func TestIntegrationConcurrentRequests(t *testing.T) {
	base := tempBase(t)
	root, _ := committedRepo(t, base)
	s := newService(newTestGuard(t, []string{base}, nil), Options{})
	actions := []client.RepoRequest{
		{Action: "context"},
		{Action: "status"},
		{Action: "log"},
		{Action: "list"},
		{Action: "diff", File: ptr("both.txt"), Scope: ptr("staged")},
	}
	var wg sync.WaitGroup
	results := make([]*protocol.RepoError, 4*len(actions))
	for i := range results {
		wg.Go(func() {
			req := actions[i%len(actions)]
			req.Type, req.RequestID, req.ID = "repo:request", "r", "%1"
			if e, ok := s.Request(t.Context(), root, &req).Result.(*protocol.RepoError); ok {
				results[i] = e
			}
		})
	}
	wg.Wait()
	for i, e := range results {
		if e != nil {
			t.Errorf("request %d (%s): %s", i, actions[i%len(actions)].Action, e.Message)
		}
	}
}
