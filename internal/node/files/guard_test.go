package files

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"syscall"
	"testing"

	"tmuxde/internal/node"
	"tmuxde/internal/protocol"
)

// Ported from apps/relay/src/file-service.test.ts, "the credential
// deny-list".
func TestCredentialDenyList(t *testing.T) {
	f := newFixture(t)
	tests := []struct {
		name  string
		paths []string
		want  bool
	}{
		{
			name:  "refuses host config even when relay state uses another directory",
			paths: []string{f.serviceState, f.tmuxde, filepath.Join(f.tmuxde, "config.json")},
			want:  false,
		},
		{
			name: "refuses the neighbouring credential directories",
			paths: []string{
				f.ssh, filepath.Join(f.ssh, "id_rsa"),
				filepath.Join(f.user, ".tmuxremote"),
				filepath.Join(f.user, ".aws", "credentials"),
				filepath.Join(f.user, ".gnupg"),
				filepath.Join(f.user, ".config", "gh", "hosts.yml"),
				filepath.Join(f.user, ".kube", "config"),
			},
			want: false,
		},
		{
			name:  "refuses a symlink inside the allowed root pointing at a denied one",
			paths: []string{f.shortcut, filepath.Join(f.shortcut, "id_rsa")},
			want:  false,
		},
		{
			name:  "still allows a sibling that merely shares the prefix",
			paths: []string{f.tmuxdefoo, filepath.Join(f.tmuxdefoo, "notes.txt")},
			want:  true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, p := range tt.paths {
				if got := allowed(t, f.guard, p); got != tt.want {
					t.Errorf("allowed(%q) = %v, want %v", p, got, tt.want)
				}
			}
		})
	}

	t.Run("reports the denial directly too", func(t *testing.T) {
		if _, err := f.guard.Resolve(filepath.Join(f.tmuxde, "config.json")); err != node.ErrDenied {
			t.Errorf("Resolve error = %v, want node.ErrDenied itself", err)
		}
		if f.guard.Allowed(filepath.Join(f.tmuxde, "config.json")) {
			t.Error("Allowed(.tmuxde/config.json) = true")
		}
		if !f.guard.Allowed(f.tmuxdefoo) {
			t.Error("Allowed(.tmuxdefoo) = false")
		}
	})
}

// Ported from apps/relay/src/file-service.test.ts, "isPathAllowed".
func TestIsPathAllowed(t *testing.T) {
	f := newFixture(t)
	tests := []struct {
		name  string
		paths []string
		want  bool
	}{
		{"allows the exact allowed root", []string{f.user}, true},
		{
			"allows a subpath of the allowed root",
			[]string{f.sub, filepath.Join(f.sub, "deep", "nested")},
			true,
		},
		{
			"allows a not-yet-existing file inside the allowed root",
			[]string{filepath.Join(f.user, "new-file.txt")},
			true,
		},
		{
			"rejects a sibling directory that merely shares a string prefix",
			[]string{f.userdata, filepath.Join(f.userdata, "file.txt")},
			false,
		},
		{
			"rejects `..` traversal that escapes the allowed root",
			[]string{f.user + "/../..", f.user + "/../outside"},
			false,
		},
		{
			"rejects a symlink inside the allowed root that points outside it",
			[]string{f.escape, filepath.Join(f.escape, "secret.txt")},
			false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, p := range tt.paths {
				if got := allowed(t, f.guard, p); got != tt.want {
					t.Errorf("allowed(%q) = %v, want %v", p, got, tt.want)
				}
			}
		})
	}
}

func TestResolveReturnsRealPath(t *testing.T) {
	f := newFixture(t)
	link := filepath.Join(f.user, "to-sub")
	symlink(t, "sub", link)
	tests := []struct {
		in, want string
	}{
		{f.user, f.user},
		{link, f.sub},
		{filepath.Join(link, "new.txt"), filepath.Join(f.sub, "new.txt")},
		{f.user + "/sub/../sub/./x", filepath.Join(f.sub, "x")},
	}
	for _, tt := range tests {
		got, err := f.guard.Resolve(tt.in)
		if err != nil || got != tt.want {
			t.Errorf("Resolve(%q) = %q, %v, want %q", tt.in, got, err, tt.want)
		}
	}
}

func TestGuardRefusesEmptyAndRelativePaths(t *testing.T) {
	f := newFixture(t)
	t.Chdir(f.user)
	for _, p := range []string{"", ".", "sub", "./sub", "../user"} {
		if _, err := f.guard.Resolve(p); err != node.ErrDenied {
			t.Errorf("Resolve(%q) error = %v, want node.ErrDenied", p, err)
		}
		if f.guard.Allowed(p) {
			t.Errorf("Allowed(%q) = true", p)
		}
	}
}

// Port note 4: the relay fell back one level only. A missing path two
// levels below a symlink that leaves the root came back as the lexical
// path and passed.
func TestResolveWalksEveryMissingAncestor(t *testing.T) {
	f := newFixture(t)
	deep := filepath.Join(f.escape, "missing", "deeper", "file.txt")
	if allowed(t, f.guard, deep) {
		t.Errorf("allowed(%q) = true, the escape link was not followed", deep)
	}
	link := filepath.Join(f.user, "to-sub")
	symlink(t, f.sub, link)
	got, err := f.guard.Resolve(filepath.Join(link, "a", "b", "c.txt"))
	want := filepath.Join(f.sub, "a", "b", "c.txt")
	if err != nil || got != want {
		t.Errorf("Resolve = %q, %v, want %q", got, err, want)
	}
}

// Port note 4, second half: errno values other than ENOENT are errors,
// not a fallback.
func TestResolveReturnsOtherErrno(t *testing.T) {
	f := newFixture(t)
	file := filepath.Join(f.user, "file.txt")
	writeFile(t, file, "x")
	_, err := f.guard.Resolve(filepath.Join(file, "child"))
	if !errors.Is(err, syscall.ENOTDIR) {
		t.Errorf("Resolve below a file: error = %v, want ENOTDIR", err)
	}

	t.Run("permission", func(t *testing.T) {
		skipIfRoot(t)
		locked := filepath.Join(f.user, "locked")
		mkdir(t, locked)
		if err := os.Chmod(locked, 0); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(locked, 0o755) })
		_, err := f.guard.Resolve(filepath.Join(locked, "x"))
		if !errors.Is(err, syscall.EACCES) {
			t.Errorf("Resolve in locked dir: error = %v, want EACCES", err)
		}
	})

	t.Run("outside the roots the errno stays hidden", func(t *testing.T) {
		_, err := f.guard.Resolve(filepath.Join(f.outside, "secret.txt", "child"))
		if err != node.ErrDenied {
			t.Errorf("error = %v, want node.ErrDenied", err)
		}
	})
}

func TestResolveFollowsDanglingLinks(t *testing.T) {
	f := newFixture(t)
	out := filepath.Join(f.user, "dangle-out")
	symlink(t, filepath.Join(f.outside, "missing"), out)
	if allowed(t, f.guard, out) {
		t.Error("a dangling link to a missing place outside passed")
	}
	in := filepath.Join(f.user, "dangle-in")
	symlink(t, "missing-target", in)
	got, err := f.guard.Resolve(in)
	if want := filepath.Join(f.user, "missing-target"); err != nil || got != want {
		t.Errorf("Resolve = %q, %v, want %q", got, err, want)
	}
}

// A ".." after a missing element would be cleaned away lexically and could
// skip a symlink. It fails as the kernel would.
func TestResolveDotDotAfterMissing(t *testing.T) {
	f := newFixture(t)
	trick := filepath.Join(f.user, "trick")
	symlink(t, "missing/../escape/secret.txt", trick)
	got, err := f.guard.Resolve(trick)
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("Resolve = %q, %v, want ENOENT", got, err)
	}
}

func TestResolveSymlinkLoop(t *testing.T) {
	f := newFixture(t)
	a, b := filepath.Join(f.user, "a"), filepath.Join(f.user, "b")
	symlink(t, b, a)
	symlink(t, a, b)
	if _, err := f.guard.Resolve(filepath.Join(a, "x")); !errors.Is(err, syscall.ELOOP) {
		t.Errorf("error = %v, want ELOOP", err)
	}
}

// The lexical form is checked too. A link outside the roots that points
// inside is refused itself, while paths below it resolve through it.
func TestResolveChecksLexicalPath(t *testing.T) {
	f := newFixture(t)
	into := filepath.Join(f.outside, "into")
	symlink(t, f.sub, into)
	if allowed(t, f.guard, into) {
		t.Error("a link outside the root that points inside passed")
	}
	got, err := f.guard.Resolve(filepath.Join(into, "x"))
	if want := filepath.Join(f.sub, "x"); err != nil || got != want {
		t.Errorf("Resolve below the link = %q, %v, want %q", got, err, want)
	}
}

// Port note 5: allowed root "/" holds every path. The relay built the
// prefix "//" and matched nothing below it.
func TestRootSlashAllowsEverything(t *testing.T) {
	f := newFixture(t)
	g, err := NewGuard([]string{"/"}, f.user, f.serviceState)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed(t, g, filepath.Join(f.outside, "secret.txt")) {
		t.Error("root / refused a path below it")
	}
	if !g.Allowed("/") {
		t.Error("Allowed(/) = false")
	}
	if allowed(t, g, filepath.Join(f.ssh, "id_rsa")) {
		t.Error("root / let a denied path through")
	}
}

// Port note 6: an empty config dir means home/.tmuxde. The relay resolved
// the empty string to the working directory and denied it.
func TestEmptyConfigDirMeansDefault(t *testing.T) {
	f := newFixture(t)
	g, err := NewGuard([]string{f.user}, f.user, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(f.sub)
	if !allowed(t, g, filepath.Join(f.sub, "file.txt")) {
		t.Error("the working directory is denied")
	}
	if allowed(t, g, filepath.Join(f.tmuxde, "config.json")) {
		t.Error("home/.tmuxde is not denied")
	}
	if !allowed(t, g, f.serviceState) {
		t.Error("service-state is denied without being the config dir")
	}
}

func TestNewGuardRefusesBadInput(t *testing.T) {
	f := newFixture(t)
	tests := []struct {
		name      string
		allowed   []string
		home, cfg string
	}{
		{"empty home", []string{f.user}, "", ""},
		{"relative home", []string{f.user}, "user", ""},
		{"relative config dir", []string{f.user}, f.user, "state"},
		{"relative root", []string{"user"}, f.user, ""},
		{"empty root", []string{""}, f.user, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := NewGuard(tt.allowed, tt.home, tt.cfg); err == nil {
				t.Error("NewGuard accepted it")
			}
		})
	}
}

func TestNoAllowedRootsAllowNothing(t *testing.T) {
	f := newFixture(t)
	g, err := NewGuard(nil, f.user, f.serviceState)
	if err != nil {
		t.Fatal(err)
	}
	if allowed(t, g, f.sub) {
		t.Error("a guard without roots allowed a path")
	}
}

// Allowed roots are resolved on every call. A root that appears or moves
// later is followed.
func TestAllowedRootsResolvedPerCall(t *testing.T) {
	f := newFixture(t)
	later := filepath.Join(f.base, "later")
	g, err := NewGuard([]string{later}, f.user, f.serviceState)
	if err != nil {
		t.Fatal(err)
	}
	if allowed(t, g, filepath.Join(f.sub, "x")) {
		t.Fatal("sub allowed before the root link exists")
	}
	symlink(t, f.sub, later)
	got, err := g.Resolve(filepath.Join(later, "x"))
	if want := filepath.Join(f.sub, "x"); err != nil || got != want {
		t.Errorf("Resolve = %q, %v, want %q", got, err, want)
	}
	if !g.Allowed(filepath.Join(f.sub, "x")) {
		t.Error("Allowed of the real path = false")
	}
}

// Denied roots are resolved once by NewGuard. A link made later at a
// denied name is still denied by name, but its target is not.
func TestDeniedRootsResolvedOnce(t *testing.T) {
	f := newFixture(t)
	real := filepath.Join(f.user, "kube-real")
	mkdir(t, real)

	t.Run("link present at start", func(t *testing.T) {
		kube := filepath.Join(f.user, ".kube")
		symlink(t, real, kube)
		t.Cleanup(func() { os.Remove(kube) })
		g, err := NewGuard([]string{f.user}, f.user, f.serviceState)
		if err != nil {
			t.Fatal(err)
		}
		if allowed(t, g, filepath.Join(real, "config")) {
			t.Error("the target of a denied link is allowed")
		}
	})

	t.Run("link made later", func(t *testing.T) {
		g, err := NewGuard([]string{f.user}, f.user, f.serviceState)
		if err != nil {
			t.Fatal(err)
		}
		kube := filepath.Join(f.user, ".kube")
		symlink(t, real, kube)
		t.Cleanup(func() { os.Remove(kube) })
		if allowed(t, g, filepath.Join(kube, "config")) {
			t.Error("the denied name is allowed")
		}
		if !allowed(t, g, filepath.Join(real, "config")) {
			t.Error("the target was resolved again")
		}
	})
}

// An allowed root configured through a symlink, such as /home on Fedora
// Atomic or /tmp on macOS, passes by its configured name. Before, its
// lexical form was the link itself, outside every resolved root, so the
// file browser could not open its default path.
func TestRootConfiguredThroughLink(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	link := filepath.Join(f.base, "root-link")
	symlink(t, f.user, link)
	other := filepath.Join(f.base, "other-link")
	symlink(t, f.user, other)
	g, err := NewGuard([]string{link}, f.user, f.serviceState)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(g, Options{Logger: slog.New(slog.DiscardHandler)})

	tests := []struct {
		name string
		path string
		want bool
	}{
		{"the configured name", link, true},
		{"the configured name with a slash", link + "/", true},
		{"below the configured name", filepath.Join(link, "sub"), true},
		{"the real root", f.user, true},
		{"another link to the root", other, false},
		{"below another link to the root", filepath.Join(other, "sub"), true},
		{"escape below the name", filepath.Join(link, "escape"), false},
		{"denied below the name", filepath.Join(link, ".ssh"), false},
		{"denied through a shortcut", filepath.Join(link, "shortcut", "id_rsa"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := allowed(t, g, tt.path); got != tt.want {
				t.Errorf("allowed(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}

	if got, err := g.Resolve(link); err != nil || got != f.user {
		t.Errorf("Resolve(link) = %q, %v, want %q", got, err, f.user)
	}
	entries, err := svc.List(ctx, link)
	if err != nil {
		t.Fatalf("List(link): %v", err)
	}
	if !slices.ContainsFunc(entries, func(e protocol.FileEntry) bool { return e.Path == f.sub }) {
		t.Errorf("List(link) has no entry for sub: %v", entries)
	}

	// The root stays protected under its configured name.
	wantMessage(t, svc.Delete(ctx, link), msgRootDelete)
	file := filepath.Join(f.sub, "file.txt")
	writeFile(t, file, "x")
	wantMessage(t, svc.Rename(ctx, link, filepath.Join(f.sub, "moved")), msgRootRename)
	wantMessage(t, svc.Rename(ctx, file, link), msgRootRename)
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&fs.ModeSymlink == 0 {
		t.Fatalf("the root link changed: %v, %v", fi, err)
	}
	if !exists(t, file) || exists(t, filepath.Join(f.sub, "moved")) {
		t.Error("a refused rename moved something")
	}
}

func TestIsWithin(t *testing.T) {
	tests := []struct {
		p, root string
		want    bool
	}{
		{"/home/user", "/home/user", true},
		{"/home/user/x", "/home/user", true},
		{"/home/userdata", "/home/user", false},
		{"/home/user/.tmuxdefoo", "/home/user/.tmuxde", false},
		{"/home", "/home/user", false},
		{"/", "/", true},
		{"/x/y", "/", true},
	}
	for _, tt := range tests {
		if got := isWithin(tt.p, tt.root); got != tt.want {
			t.Errorf("isWithin(%q, %q) = %v, want %v", tt.p, tt.root, got, tt.want)
		}
	}
}

func TestDefaultPath(t *testing.T) {
	f := newFixture(t)
	link := filepath.Join(f.base, "root-link")
	symlink(t, f.user, link)
	g, err := NewGuard([]string{link, f.userdata}, f.user, f.serviceState)
	if err != nil {
		t.Fatal(err)
	}
	if got := New(g, Options{}).DefaultPath(); got != f.user {
		t.Errorf("DefaultPath = %q, want the first root resolved %q", got, f.user)
	}
	g, err = NewGuard(nil, f.user, f.serviceState)
	if err != nil {
		t.Fatal(err)
	}
	if got := New(g, Options{}).DefaultPath(); got != f.user {
		t.Errorf("DefaultPath without roots = %q, want home %q", got, f.user)
	}
}
