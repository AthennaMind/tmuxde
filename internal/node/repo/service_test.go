package repo

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"slices"

	"syscall"
	"testing"
	"time"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
)

func TestList(t *testing.T) {
	base := tempBase(t)
	dir := filepath.Join(base, "dir")
	for _, d := range []string{"sub", "Zed", ".ssh"} {
		mustMkdir(t, filepath.Join(dir, d))
	}
	for _, f := range []string{"b.txt", "A.txt", "a.txt", "_x.txt"} {
		mustWrite(t, filepath.Join(dir, f), "1234")
	}
	mustSymlink(t, filepath.Join(dir, "sub"), filepath.Join(dir, "link-dir"))
	mustSymlink(t, t.TempDir(), filepath.Join(dir, "link-out"))
	mustSymlink(t, filepath.Join(dir, "gone"), filepath.Join(dir, "dangling"))
	if err := syscall.Mkfifo(filepath.Join(dir, "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	g := newTestGuard(t, []string{base}, []string{filepath.Join(dir, ".ssh")})

	t.Run("sorts, follows links and drops refused entries", func(t *testing.T) {
		s := newService(g, Options{})
		got := as[*protocol.RepoList](t, request(t, s, base, client.RepoRequest{Action: "list", Path: ptr("dir")}))
		if got.Path != dir || got.Truncated {
			t.Fatalf("list = path %q truncated %v", got.Path, got.Truncated)
		}
		var names, types []string
		for _, e := range got.Entries {
			names = append(names, e.Name)
			types = append(types, e.Type)
			if e.Path != filepath.Join(dir, e.Name) {
				t.Errorf("%s path = %q", e.Name, e.Path)
			}
			if _, err := time.Parse("2006-01-02T15:04:05.000Z", e.Modified); err != nil {
				t.Errorf("%s modified %q: %v", e.Name, e.Modified, err)
			}
		}
		wantNames := []string{"link-dir", "sub", "Zed", "_x.txt", "A.txt", "a.txt", "b.txt", "pipe"}
		wantTypes := []string{"directory", "directory", "directory", "file", "file", "file", "file", "other"}
		if !slices.Equal(names, wantNames) || !slices.Equal(types, wantTypes) {
			t.Fatalf("entries %q %q, want %q %q", names, types, wantNames, wantTypes)
		}
		if got.Entries[4].Size != 4 {
			t.Errorf("size = %v, want 4", got.Entries[4].Size)
		}
	})

	t.Run("lists the pane directory without a path", func(t *testing.T) {
		s := newService(g, Options{})
		got := as[*protocol.RepoList](t, request(t, s, dir, client.RepoRequest{Action: "list"}))
		if got.Path != dir || len(got.Entries) != 8 {
			t.Fatalf("list = %q with %d entries", got.Path, len(got.Entries))
		}
	})

	t.Run("caps inspected entries", func(t *testing.T) {
		s := newService(g, Options{MaxEntries: 3})
		got := as[*protocol.RepoList](t, request(t, s, dir, client.RepoRequest{Action: "list"}))
		if !got.Truncated || len(got.Entries) > 3 {
			t.Fatalf("list = %d entries truncated %v", len(got.Entries), got.Truncated)
		}
	})
}

func TestReads(t *testing.T) {
	base := tempBase(t)
	s := newService(newTestGuard(t, []string{base}, nil), Options{ReadLimit: 4})
	tests := []struct {
		name, content, want string
		truncated           bool
	}{
		{"cut inside a character drops its first bytes", "abc\u00e9", "abc", true},
		{"cut after a character keeps it", "ab\u00e9x", "ab\u00e9", true},
		{"exactly the limit is not truncated", "abcd", "abcd", false},
		{"invalid bytes become U+FFFD", "ab\xff", "ab\ufffd", false},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			file := filepath.Join(base, "f"+string(rune('0'+i)))
			mustWrite(t, file, tt.content)
			got := as[*protocol.RepoRead](t, request(t, s, base, client.RepoRequest{Action: "read", Path: ptr(file)}))
			if got.Content != tt.want || got.Truncated != tt.truncated || got.Binary || got.Path != file {
				t.Fatalf("read = %+v, want content %q truncated %v", got, tt.want, tt.truncated)
			}
		})
	}

	t.Run("reads through an allowed symlink and reports the real path", func(t *testing.T) {
		mustWrite(t, filepath.Join(base, "target"), "ok")
		mustSymlink(t, filepath.Join(base, "target"), filepath.Join(base, "alias"))
		got := as[*protocol.RepoRead](t, request(t, s, base, client.RepoRequest{Action: "read", Path: ptr("alias")}))
		if got.Path != filepath.Join(base, "target") || got.Content != "ok" {
			t.Fatalf("read = %+v", got)
		}
	})
}

func TestUntrackedPatch(t *testing.T) {
	name := "a\"b\\c\x01\t\u2028<&>.txt"
	header := jsString(name)
	if want := `"a\"b\\c\u0001\t` + "\u2028" + `<&>.txt"`; header != want {
		t.Fatalf("jsString = %q, want %q", header, want)
	}
	var back string
	if err := json.Unmarshal([]byte(header), &back); err != nil || back != name {
		t.Fatalf("jsString does not decode back: %q %v", back, err)
	}

	tests := []struct {
		name string
		in   text
		want string
	}{
		{"terminated", text{content: "x\n"}, "--- /dev/null\n+++ \"f\"\n@@ -0,0 +1,1 @@\n+x\n"},
		{"unterminated", text{content: "x\ny"}, "--- /dev/null\n+++ \"f\"\n@@ -0,0 +1,2 @@\n+x\n+y\n\\ No newline at end of file\n"},
		{"truncated", text{content: "x\ny", truncated: true}, "--- /dev/null\n+++ \"f\"\n@@ -0,0 +1,2 @@\n+x\n+y\n"},
		{"lone newline", text{content: "\n"}, "--- /dev/null\n+++ \"f\"\n@@ -0,0 +1,1 @@\n+\n"},
		{"empty", text{}, ""},
		{"binary", text{binary: true}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := untrackedPatch("f", tt.in); got != tt.want {
				t.Fatalf("patch = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPatchSections(t *testing.T) {
	// File content with a carriage return before "diff --git " must not
	// start a section. The relay split there and shifted later patches.
	patch := "diff --git a/x b/x\n+one\rdiff --git a/y b/y\n" +
		"diff --git a/z b/z\n+two\n"
	got := patchSections("lead\n" + patch)
	want := []string{"diff --git a/x b/x\n+one\rdiff --git a/y b/y\n", "diff --git a/z b/z\n+two\n"}
	if !slices.Equal(got, want) {
		t.Fatalf("sections = %q, want %q", got, want)
	}
}

func TestCompareNames(t *testing.T) {
	names := []string{"b", "B", "a", "_c", "A", "10", "\u00e9", "E", "ab", "a"}
	slices.SortFunc(names, compareNames)
	want := []string{"10", "_c", "A", "a", "a", "ab", "B", "b", "E", "\u00e9"}
	if !slices.Equal(names, want) {
		t.Fatalf("sorted = %q, want %q", names, want)
	}
}

// passGuard returns every path as given. It stands for a guard that
// resolved a path just before a symlink was swapped in at its last
// element.
type passGuard struct{}

func (passGuard) Resolve(p string) (string, error) { return p, nil }

func (passGuard) Allowed(string) bool { return true }

// textFile opens the resolved path with O_NOFOLLOW. A link found there was
// swapped in after the guard ran and is not followed.
func TestTextFileRefusesSwappedLink(t *testing.T) {
	base := tempBase(t)
	secret := filepath.Join(base, "secret.txt")
	if err := os.WriteFile(secret, []byte("top secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "swapped")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}
	s := newService(passGuard{}, Options{})
	if got, err := s.textFile(link); !errors.Is(err, syscall.ELOOP) {
		t.Fatalf("textFile(link) = %+v, %v, want ELOOP", got, err)
	}
	if got, err := s.textFile(secret); err != nil || got.content != "top secret" {
		t.Fatalf("textFile(file) = %+v, %v", got, err)
	}
}

func TestSearch(t *testing.T) {
	base := tempBase(t)
	dir := filepath.Join(base, "project")
	mustMkdir(t, dir)
	mustWrite(t, filepath.Join(dir, "button.tsx"), "")
	mustWrite(t, filepath.Join(base, "outside.tsx"), "")
	s := newService(newTestGuard(t, []string{base}, nil), Options{})
	got := as[*protocol.RepoSearch](t, request(t, s, base, client.RepoRequest{Action: "search", Path: ptr("project"), Query: ptr("tsx")}))
	if got.Path != dir || !slices.Equal(got.Files, []string{"button.tsx"}) {
		t.Fatalf("search = %+v", got)
	}
	for _, query := range []*string{nil, ptr("  "), ptr(strings.Repeat("x", 257))} {
		as[*protocol.RepoError](t, request(t, s, base, client.RepoRequest{Action: "search", Query: query}))
	}
	s.searchMu.Lock()
	as[*protocol.RepoError](t, request(t, s, base, client.RepoRequest{Action: "search", Query: ptr("tsx")}))
	s.searchMu.Unlock()
}
