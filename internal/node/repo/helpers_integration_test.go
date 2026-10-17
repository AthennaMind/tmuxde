//go:build integration

package repo

import (
	"bytes"

	"os"
	"os/exec"
	"path/filepath"

	"strings"
	"testing"
)

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
		t.Fatal("git not installed")
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
