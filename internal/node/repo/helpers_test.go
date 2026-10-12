package repo

import (
	"bytes"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"tmuxde/internal/node"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// testGuard behaves like the files package guard: allowed and denied roots
// compared after real path resolution, missing ancestors resolved one by
// one, empty and relative paths refused.
type testGuard struct {
	allowed []string
	denied  []string
}

func newTestGuard(t *testing.T, allowed, denied []string) *testGuard {
	t.Helper()
	g := &testGuard{}
	for _, p := range allowed {
		r, err := realpath(p)
		if err != nil {
			t.Fatalf("allowed root %s: %v", p, err)
		}
		g.allowed = append(g.allowed, r)
	}
	for _, p := range denied {
		r, err := realpath(p)
		if err != nil {
			t.Fatalf("denied root %s: %v", p, err)
		}
		g.denied = append(g.denied, r)
	}
	return g
}

func (g *testGuard) Resolve(p string) (string, error) {
	if p == "" || !filepath.IsAbs(p) {
		return "", node.ErrDenied
	}
	abs := filepath.Clean(p)
	real, err := realpath(abs)
	if err != nil {
		return "", err
	}
	if !g.Allowed(abs) || !g.Allowed(real) {
		return "", node.ErrDenied
	}
	return real, nil
}

func (g *testGuard) Allowed(p string) bool {
	for _, d := range g.denied {
		if within(p, d) {
			return false
		}
	}
	for _, a := range g.allowed {
		if within(p, a) {
			return true
		}
	}
	return false
}

func within(p, root string) bool {
	if root == "/" {
		return strings.HasPrefix(p, "/")
	}
	return p == root || strings.HasPrefix(p, root+"/")
}

// realpath resolves symlinks. A missing path resolves through its parent.
func realpath(p string) (string, error) {
	r, err := filepath.EvalSymlinks(p)
	if err == nil {
		return r, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	parent := filepath.Dir(p)
	if parent == p {
		return "", err
	}
	rp, err := realpath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(rp, filepath.Base(p)), nil
}

// tempBase is a fresh real temp directory. HOME and XDG_CONFIG_HOME point
// into it, so neither the service nor the test git reads user files.
func tempBase(t *testing.T) string {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", filepath.Join(base, "home"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(base, "home", ".config"))
	return base
}

// gitRunner runs the real git for fixtures, never on the service's PATH
// lookup. Each call gets -c commit.gpgsign=false and the test identity.
type gitRunner struct {
	t   *testing.T
	bin string
	env []string
}

func newGit(t *testing.T, home string) *gitRunner {
	t.Helper()
	bin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "GIT_") || k == "HOME" || k == "XDG_CONFIG_HOME" || k == "LC_ALL" {
			continue
		}
		env = append(env, kv)
	}
	env = append(env,
		"HOME="+home,
		"XDG_CONFIG_HOME="+filepath.Join(home, ".config"),
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_EDITOR=true",
		"GIT_MERGE_AUTOEDIT=no",
		"GIT_AUTHOR_NAME=Test",
		"GIT_AUTHOR_EMAIL=test@example.invalid",
		"GIT_COMMITTER_NAME=Test",
		"GIT_COMMITTER_EMAIL=test@example.invalid",
		"LC_ALL=C",
	)
	return &gitRunner{t: t, bin: bin, env: env}
}

// try runs git in dir and returns stdout and stderr.
func (g *gitRunner) try(dir, input string, args ...string) (string, string, error) {
	argv := append([]string{"-c", "commit.gpgsign=false", "-C", dir}, args...)
	cmd := exec.Command(g.bin, argv...)
	cmd.Env = g.env
	cmd.Stdin = strings.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

// run runs git in dir and fails the test on error.
func (g *gitRunner) run(dir string, args ...string) string {
	g.t.Helper()
	return g.runInput(dir, "", args...)
}

func (g *gitRunner) runInput(dir, input string, args ...string) string {
	g.t.Helper()
	out, stderr, err := g.try(dir, input, args...)
	if err != nil {
		g.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, stderr)
	}
	return out
}

// init makes dir a repository with the test identity in its config.
func (g *gitRunner) init(dir string, args ...string) {
	g.t.Helper()
	g.run(dir, append([]string{"init", "-q"}, args...)...)
	g.run(dir, "config", "user.email", "test@example.invalid")
	g.run(dir, "config", "user.name", "Test")
}

var quiet = slog.New(slog.DiscardHandler)

func newService(g Guard, opts Options) *Service {
	opts.Logger = quiet
	return New(g, opts)
}

// request sends one request and checks that the reply is a valid
// repo:result for it, as the browser would decode it.
func request(t *testing.T, s *Service, cwd string, req client.RepoRequest) protocol.RepoResult {
	t.Helper()
	req.Type = "repo:request"
	if req.RequestID == "" {
		req.RequestID = "r1"
	}
	if req.ID == "" {
		req.ID = "%1"
	}
	res := s.Request(t.Context(), cwd, &req)
	if res == nil {
		t.Fatal("Request returned nil")
	}
	if res.Type != "repo:result" || res.RequestID != req.RequestID {
		t.Fatalf("envelope = %q %q, want repo:result %q", res.Type, res.RequestID, req.RequestID)
	}
	data, err := server.Encode(res)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if _, err := server.Decode(data); err != nil {
		t.Fatalf("decode %s: %v", data, err)
	}
	return res.Result
}

// as returns the result as T or fails with what came back instead.
func as[T protocol.RepoResult](t *testing.T, r protocol.RepoResult) T {
	t.Helper()
	v, ok := r.(T)
	if !ok {
		t.Fatalf("result = %s, want %T", describe(r), *new(T))
	}
	return v
}

func describe(r protocol.RepoResult) string {
	if e, ok := r.(*protocol.RepoError); ok {
		return "error " + e.Message
	}
	return r.RepoKind()
}

// errorText returns the message of an error result.
func errorText(t *testing.T, r protocol.RepoResult) string {
	t.Helper()
	return as[*protocol.RepoError](t, r).Message
}

// wantError checks that r is an error whose message matches pattern.
func wantError(t *testing.T, r protocol.RepoResult, pattern string) {
	t.Helper()
	msg := errorText(t, r)
	if !regexp.MustCompile(pattern).MatchString(msg) {
		t.Fatalf("error %q does not match %q", msg, pattern)
	}
}

func ptr[T any](v T) *T { return &v }

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func missing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("%s exists or cannot be checked: %v", path, err)
	}
}
