package files

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"tmuxde/internal/node"
)

// fixture is the layout of the relay file-service.test.ts, under one
// t.TempDir. Home is user and the only allowed root is user.
//
//	base/
//	  user/                 home and allowed root
//	    sub/
//	    escape -> base/outside
//	    service-state/      config dir, denied
//	    .tmuxde/config.json denied
//	    .ssh/id_rsa         denied
//	    .tmuxdefoo/notes.txt only shares a prefix, allowed
//	    shortcut -> user/.ssh
//	  userdata/             shares a prefix with user, outside
//	  outside/secret.txt    outside
type fixture struct {
	base, user, userdata, sub, outside, escape string
	serviceState, tmuxde, ssh, tmuxdefoo       string
	shortcut                                   string
	guard                                      *Guard
	svc                                        *Service
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{base: base}
	f.user = filepath.Join(base, "user")
	f.userdata = filepath.Join(base, "userdata")
	f.sub = filepath.Join(f.user, "sub")
	f.outside = filepath.Join(base, "outside")
	f.escape = filepath.Join(f.user, "escape")
	f.serviceState = filepath.Join(f.user, "service-state")
	f.tmuxde = filepath.Join(f.user, ".tmuxde")
	f.ssh = filepath.Join(f.user, ".ssh")
	f.tmuxdefoo = filepath.Join(f.user, ".tmuxdefoo")
	f.shortcut = filepath.Join(f.user, "shortcut")

	for _, d := range []string{f.user, f.userdata, f.sub, f.outside, f.serviceState, f.tmuxde, f.ssh, f.tmuxdefoo} {
		mkdir(t, d)
	}
	writeFile(t, filepath.Join(f.outside, "secret.txt"), "top secret")
	writeFile(t, filepath.Join(f.tmuxde, "config.json"), "{}")
	writeFile(t, filepath.Join(f.ssh, "id_rsa"), "-----BEGIN-----")
	writeFile(t, filepath.Join(f.tmuxdefoo, "notes.txt"), "harmless")
	symlink(t, f.outside, f.escape)
	symlink(t, f.ssh, f.shortcut)

	f.guard, err = NewGuard([]string{f.user}, f.user, f.serviceState)
	if err != nil {
		t.Fatal(err)
	}
	f.svc = New(f.guard, Options{Logger: slog.New(slog.DiscardHandler)})
	return f
}

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func exists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Lstat(path)
	if err == nil {
		return true
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return false
}

// allowed is isPathAllowed of the relay tests: true when Resolve passes,
// false when it denies. Any other error fails the test.
func allowed(t *testing.T, g *Guard, path string) bool {
	t.Helper()
	_, err := g.Resolve(path)
	switch {
	case err == nil:
		return true
	case errors.Is(err, node.ErrDenied):
		return false
	}
	t.Fatalf("Resolve(%q): unexpected error %v", path, err)
	return false
}

// wantMessage checks that err is an *Error with text msg.
func wantMessage(t *testing.T, err error, msg string) {
	t.Helper()
	var fe *Error
	if !errors.As(err, &fe) {
		t.Fatalf("error %v (%T) is not an *Error", err, err)
	}
	if err.Error() != msg {
		t.Fatalf("error = %q, want %q", err.Error(), msg)
	}
}

// skipIfRoot skips checks that rely on permission bits. Root passes every
// access check.
func skipIfRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("permission bits do not apply to root")
	}
}

// tempFiles lists the names in dir that look like temp files of this
// package.
func tempFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if tempName.MatchString(e.Name()) {
			out = append(out, e.Name())
		}
	}
	return out
}

var tempName = regexp.MustCompile(`^\..*\.tmuxde-(upload|write)-[0-9a-f]{16}$`)
