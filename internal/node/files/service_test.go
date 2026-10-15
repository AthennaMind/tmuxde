package files

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"tmuxde/internal/node"
	"tmuxde/internal/protocol"
)

var isoPattern = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`)

func TestList(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.user, "list")
	mkdir(t, filepath.Join(dir, "Zdir"))
	mkdir(t, filepath.Join(dir, "adir"))
	writeFile(t, filepath.Join(dir, "b.txt"), "hello")
	writeFile(t, filepath.Join(dir, "A.txt"), "")
	writeFile(t, filepath.Join(dir, ".hidden"), "")
	symlink(t, "adir", filepath.Join(dir, "link-dir"))
	symlink(t, "missing", filepath.Join(dir, "broken"))
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 678_900_000, time.UTC)
	if err := os.Chtimes(filepath.Join(dir, "b.txt"), stamp, stamp); err != nil {
		t.Fatal(err)
	}

	// Through a link, to check that paths use the real directory.
	via := filepath.Join(f.user, "via")
	symlink(t, dir, via)
	entries, err := f.svc.List(context.Background(), via)
	if err != nil {
		t.Fatal(err)
	}
	var names, types []string
	for _, e := range entries {
		names = append(names, e.Name)
		types = append(types, e.Type)
		if e.Path != filepath.Join(dir, e.Name) {
			t.Errorf("%s: path = %q, want under %q", e.Name, e.Path, dir)
		}
		if !isoPattern.MatchString(e.Modified) {
			t.Errorf("%s: modified = %q", e.Name, e.Modified)
		}
		if err := e.Validate(); err != nil {
			t.Errorf("%s: %v", e.Name, err)
		}
	}
	wantNames := []string{"adir", "Zdir", ".hidden", "A.txt", "b.txt", "link-dir"}
	wantTypes := []string{"directory", "directory", "file", "file", "file", "symlink"}
	if !slices.Equal(names, wantNames) || !slices.Equal(types, wantTypes) {
		t.Errorf("names %q types %q, want %q %q", names, types, wantNames, wantTypes)
	}
	b := entries[slices.IndexFunc(entries, func(e protocol.FileEntry) bool { return e.Name == "b.txt" })]
	if b.Size != 5 || b.Modified != "2026-01-02T03:04:05.678Z" {
		t.Errorf("b.txt size %v modified %q", b.Size, b.Modified)
	}

	empty := filepath.Join(f.user, "empty")
	mkdir(t, empty)
	entries, err = f.svc.List(context.Background(), empty)
	if err != nil || entries == nil || len(entries) != 0 {
		t.Errorf("empty dir: %#v, %v, want a non nil empty slice", entries, err)
	}
}

func TestCompareNames(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"a", "B", -1},
		{"B", "a", 1},
		{"A", "a", -1},
		{"a", "A", 1},
		{"ab", "abc", -1},
		{"ABC", "abd", -1},
		{"_x", "a", -1},
		{".hidden", "A", -1},
		{"\u00e9", "z", 1},
		{"\u212a", "k", 1},
		{"k", "L", -1},
		{"\u212a", "L", -1},
		{"\u03a3", "\u03c3", -1},
		{"same", "same", 0},
	}
	for _, tt := range tests {
		if got := compareNames(tt.a, tt.b); got != tt.want {
			t.Errorf("compareNames(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
		if got := compareNames(tt.b, tt.a); got != -tt.want {
			t.Errorf("compareNames(%q, %q) = %d, want %d", tt.b, tt.a, got, -tt.want)
		}
	}
}

func TestRead(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	limit := DefaultReadLimit
	tests := []struct {
		name          string
		data          string
		want          string
		wantTruncated bool
	}{
		{"small", "hello\n", "hello\n", false},
		{"exactly the limit", strings.Repeat("a", limit), strings.Repeat("a", limit), false},
		{"one over the limit", strings.Repeat("a", limit+1), strings.Repeat("a", limit), true},
		{"cut inside a character", strings.Repeat("a", limit-1) + "\u00e9", strings.Repeat("a", limit-1), true},
		{"invalid bytes", "a\xffb", "a\uFFFDb", false},
		{"incomplete at the real end", "a\xc3", "a\uFFFD", false},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := filepath.Join(f.user, "read", string(rune('a'+i)))
			mkdir(t, filepath.Dir(p))
			writeFile(t, p, tt.data)
			got, truncated, err := f.svc.Read(ctx, p)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want || truncated != tt.wantTruncated {
				t.Errorf("Read = %d bytes truncated %v, want %d bytes truncated %v",
					len(got), truncated, len(tt.want), tt.wantTruncated)
			}
		})
	}

	t.Run("through a link", func(t *testing.T) {
		writeFile(t, filepath.Join(f.sub, "t.txt"), "via link")
		symlink(t, filepath.Join(f.sub, "t.txt"), filepath.Join(f.user, "t-link"))
		got, _, err := f.svc.Read(ctx, filepath.Join(f.user, "t-link"))
		if err != nil || got != "via link" {
			t.Errorf("Read = %q, %v", got, err)
		}
	})

	t.Run("not a file", func(t *testing.T) {
		_, _, err := f.svc.Read(ctx, f.sub)
		wantMessage(t, err, "Not a file")
		if !errors.Is(err, node.ErrNotFile) {
			t.Errorf("error %v is not node.ErrNotFile", err)
		}
		fifo := filepath.Join(f.user, "fifo")
		if err := syscall.Mkfifo(fifo, 0o644); err != nil {
			t.Fatal(err)
		}
		_, _, err = f.svc.Read(ctx, fifo)
		wantMessage(t, err, "Not a file")
	})
}

func TestStat(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	file := filepath.Join(f.sub, "s.txt")
	writeFile(t, file, "12345")
	stamp := time.Date(2025, 5, 6, 7, 8, 9, 10_000_000, time.UTC)
	if err := os.Chtimes(file, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(f.user, "s-link")
	symlink(t, file, link)

	st, err := f.svc.Stat(ctx, link)
	if err != nil {
		t.Fatal(err)
	}
	want := protocol.FileStat{
		Name: "s.txt", Path: file, Type: "file", Size: 5,
		Modified: "2025-05-06T07:08:09.010Z", Created: st.Created,
		Permissions: "rw", IsReadable: true, IsWritable: true,
	}
	if st != want {
		t.Errorf("Stat = %+v, want %+v", st, want)
	}
	if !isoPattern.MatchString(st.Created) {
		t.Errorf("created = %q", st.Created)
	}

	dir, err := f.svc.Stat(ctx, f.sub)
	if err != nil || dir.Type != "directory" || dir.Name != "sub" {
		t.Errorf("Stat dir = %+v, %v", dir, err)
	}

	t.Run("permissions", func(t *testing.T) {
		skipIfRoot(t)
		for _, tt := range []struct {
			mode fs.FileMode
			want string
		}{{0o444, "r"}, {0o200, "-"}, {0, "-"}, {0o644, "rw"}} {
			if err := os.Chmod(file, tt.mode); err != nil {
				t.Fatal(err)
			}
			st, err := f.svc.Stat(ctx, file)
			if err != nil {
				t.Fatal(err)
			}
			if st.Permissions != tt.want || st.IsReadable != (tt.want != "-") || st.IsWritable != (tt.want == "rw") {
				t.Errorf("mode %o: %q readable %v writable %v, want %q",
					tt.mode, st.Permissions, st.IsReadable, st.IsWritable, tt.want)
			}
		}
	})
}

func TestWrite(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	t.Run("replaces content and keeps the mode", func(t *testing.T) {
		p := filepath.Join(f.sub, "w.txt")
		writeFile(t, p, "old content")
		if err := os.Chmod(p, 0o640); err != nil {
			t.Fatal(err)
		}
		n, err := f.svc.Write(ctx, p, "new \u00e9")
		if err != nil || n != 6 {
			t.Fatalf("Write = %d, %v, want 6", n, err)
		}
		if got := readFile(t, p); got != "new \u00e9" {
			t.Errorf("content = %q", got)
		}
		fi, err := os.Stat(p)
		if err != nil || fi.Mode().Perm() != 0o640 {
			t.Errorf("mode = %v, %v, want 0640", fi.Mode(), err)
		}
		if tmp := tempFiles(t, f.sub); len(tmp) != 0 {
			t.Errorf("temp files left: %q", tmp)
		}
	})

	t.Run("limit", func(t *testing.T) {
		p := filepath.Join(f.sub, "big.txt")
		writeFile(t, p, "keep")
		_, err := f.svc.Write(ctx, p, strings.Repeat("x", DefaultWriteLimit+1))
		wantMessage(t, err, "File too large to write (1048577 bytes, max 1048576)")
		if got := readFile(t, p); got != "keep" {
			t.Errorf("content changed to %d bytes", len(got))
		}
		if n, err := f.svc.Write(ctx, p, strings.Repeat("x", DefaultWriteLimit)); err != nil || n != DefaultWriteLimit {
			t.Errorf("Write at the limit = %d, %v", n, err)
		}
	})

	t.Run("through a link keeps the link", func(t *testing.T) {
		target := filepath.Join(f.sub, "target.txt")
		writeFile(t, target, "old")
		link := filepath.Join(f.user, "w-link")
		symlink(t, target, link)
		if _, err := f.svc.Write(ctx, link, "new"); err != nil {
			t.Fatal(err)
		}
		if got := readFile(t, target); got != "new" {
			t.Errorf("target = %q", got)
		}
		if fi, err := os.Lstat(link); err != nil || fi.Mode()&fs.ModeSymlink == 0 {
			t.Errorf("link replaced: %v, %v", fi, err)
		}
	})

	t.Run("hard link is written in place", func(t *testing.T) {
		a := filepath.Join(f.sub, "hard-a")
		b := filepath.Join(f.sub, "hard-b")
		writeFile(t, a, "old")
		if err := os.Link(a, b); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Write(ctx, a, "shared"); err != nil {
			t.Fatal(err)
		}
		if got := readFile(t, b); got != "shared" {
			t.Errorf("other link = %q, want the new content", got)
		}
	})

	t.Run("not writable", func(t *testing.T) {
		skipIfRoot(t)
		p := filepath.Join(f.sub, "ro.txt")
		writeFile(t, p, "ro")
		if err := os.Chmod(p, 0o444); err != nil {
			t.Fatal(err)
		}
		_, err := f.svc.Write(ctx, p, "x")
		wantMessage(t, err, "Permission denied")
	})

	t.Run("directory", func(t *testing.T) {
		_, err := f.svc.Write(ctx, f.sub, "x")
		wantMessage(t, err, "Is a directory")
	})

	t.Run("directory not writable is written in place", func(t *testing.T) {
		skipIfRoot(t)
		dir := filepath.Join(f.user, "ro-dir")
		mkdir(t, dir)
		p := filepath.Join(dir, "w.txt")
		writeFile(t, p, "old")
		if err := os.Chmod(dir, 0o555); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
		if _, err := f.svc.Write(ctx, p, "new"); err != nil {
			t.Fatal(err)
		}
		if got := readFile(t, p); got != "new" {
			t.Errorf("content = %q", got)
		}
	})
}

// Port note 9: write keeps the must exist rule. file:create makes files.
func TestWriteNeedsExistingFile(t *testing.T) {
	f := newFixture(t)
	p := filepath.Join(f.sub, "missing.txt")
	_, err := f.svc.Write(context.Background(), p, "x")
	wantMessage(t, err, "No such file or directory")
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("error %v is not fs.ErrNotExist", err)
	}
	if exists(t, p) {
		t.Error("Write created the file")
	}
}

// umaskMode is the mode a new file with perm gets under the current umask.
func umaskMode(t *testing.T, dir string, perm fs.FileMode) fs.FileMode {
	t.Helper()
	ref := filepath.Join(dir, "umask-ref")
	fh, err := os.OpenFile(ref, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		t.Fatal(err)
	}
	fh.Close()
	defer os.Remove(ref)
	fi, err := os.Stat(ref)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode().Perm()
}

func TestCreate(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	p := filepath.Join(f.sub, "new.txt")
	if err := f.svc.Create(ctx, p, "fresh"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, p); got != "fresh" {
		t.Errorf("content = %q", got)
	}
	fi, err := os.Stat(p)
	if want := umaskMode(t, f.sub, 0o666); err != nil || fi.Mode().Perm() != want {
		t.Errorf("mode = %v, want %v", fi.Mode().Perm(), want)
	}

	wantMessage(t, f.svc.Create(ctx, p, "again"), "File exists")
	if got := readFile(t, p); got != "fresh" {
		t.Errorf("existing file changed to %q", got)
	}

	dangle := filepath.Join(f.sub, "dangle")
	symlink(t, "dangle-target", dangle)
	wantMessage(t, f.svc.Create(ctx, dangle, ""), "File exists")
	if exists(t, filepath.Join(f.sub, "dangle-target")) {
		t.Error("Create wrote through a dangling link")
	}

	wantMessage(t, f.svc.Create(ctx, filepath.Join(f.sub, "no", "x"), ""), "No such file or directory")
}

func TestMkdir(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	p := filepath.Join(f.sub, "made")
	if err := f.svc.Mkdir(ctx, p); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(p); err != nil || !fi.IsDir() {
		t.Fatalf("Stat = %v, %v", fi, err)
	}
	wantMessage(t, f.svc.Mkdir(ctx, p), "File exists")
	wantMessage(t, f.svc.Mkdir(ctx, filepath.Join(f.sub, "a", "b")), "No such file or directory")
}

func TestDelete(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	file := filepath.Join(f.sub, "del.txt")
	writeFile(t, file, "x")
	if err := f.svc.Delete(ctx, file); err != nil || exists(t, file) {
		t.Errorf("Delete file: %v, still there %v", err, exists(t, file))
	}

	dir := filepath.Join(f.sub, "tree")
	mkdir(t, filepath.Join(dir, "a", "b"))
	writeFile(t, filepath.Join(dir, "a", "b", "c.txt"), "x")
	if err := f.svc.Delete(ctx, dir); err != nil || exists(t, dir) {
		t.Errorf("Delete dir: %v, still there %v", err, exists(t, dir))
	}

	wantMessage(t, f.svc.Delete(ctx, f.user), "Cannot delete an allowed root directory")
	if !exists(t, f.user) {
		t.Fatal("root removed")
	}
	wantMessage(t, f.svc.Delete(ctx, file), "No such file or directory")
	if err := f.svc.Delete(ctx, f.shortcut); !errors.Is(err, node.ErrDenied) {
		t.Errorf("Delete of a link to a denied dir: %v", err)
	}
}

// Port note 3: delete acts on the path as named. The relay deleted the
// target of a symlink, recursively for a directory.
func TestDeleteSymlinkRemovesOnlyTheLink(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	target := filepath.Join(f.sub, "keep")
	mkdir(t, target)
	writeFile(t, filepath.Join(target, "data.txt"), "precious")
	link := filepath.Join(f.user, "keep-link")
	symlink(t, target, link)

	if err := f.svc.Delete(ctx, link); err != nil {
		t.Fatal(err)
	}
	if exists(t, link) {
		t.Error("link still there")
	}
	if got := readFile(t, filepath.Join(target, "data.txt")); got != "precious" {
		t.Errorf("target content = %q", got)
	}

	// A recursive delete never follows a link inside the tree.
	tree := filepath.Join(f.sub, "tree")
	mkdir(t, tree)
	symlink(t, target, filepath.Join(tree, "inner-link"))
	if err := f.svc.Delete(ctx, tree); err != nil {
		t.Fatal(err)
	}
	if exists(t, tree) || !exists(t, filepath.Join(target, "data.txt")) {
		t.Error("recursive delete followed a link")
	}
}

func TestRename(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	a := filepath.Join(f.sub, "a.txt")
	b := filepath.Join(f.sub, "b.txt")
	writeFile(t, a, "A")
	writeFile(t, b, "B")
	if err := f.svc.Rename(ctx, a, b); err != nil {
		t.Fatal(err)
	}
	if exists(t, a) || readFile(t, b) != "A" {
		t.Error("rename did not replace the existing file")
	}

	if err := f.svc.Rename(ctx, b, filepath.Join(f.ssh, "b.txt")); !errors.Is(err, node.ErrDenied) {
		t.Errorf("rename into a denied dir: %v", err)
	}
	if err := f.svc.Rename(ctx, filepath.Join(f.outside, "secret.txt"), filepath.Join(f.sub, "s.txt")); !errors.Is(err, node.ErrDenied) {
		t.Errorf("rename from outside: %v", err)
	}
	if !exists(t, b) || !exists(t, filepath.Join(f.outside, "secret.txt")) {
		t.Error("a refused rename moved something")
	}
	wantMessage(t, f.svc.Rename(ctx, a, filepath.Join(f.sub, "c.txt")), "No such file or directory")
}

// Port note 3: rename moves a symlink as a link. The relay renamed its
// target.
func TestRenameMovesSymlinkAsLink(t *testing.T) {
	f := newFixture(t)
	target := filepath.Join(f.sub, "target.txt")
	writeFile(t, target, "stay")
	link := filepath.Join(f.user, "ln")
	symlink(t, target, link)
	moved := filepath.Join(f.user, "ln2")
	if err := f.svc.Rename(context.Background(), link, moved); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Lstat(moved)
	if err != nil || fi.Mode()&fs.ModeSymlink == 0 {
		t.Fatalf("moved entry is not a link: %v, %v", fi, err)
	}
	if exists(t, link) || readFile(t, target) != "stay" {
		t.Error("the target moved or the link stayed")
	}
}

// Denied roots are fixed paths. Moving a directory that holds one would
// carry the denied files to a name the deny list does not cover. Before,
// renaming ~/.config made ~/cfg/gh/hosts.yml readable.
func TestRenameRefusesHolderOfDenied(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	config := filepath.Join(f.user, ".config")
	hosts := filepath.Join(config, "gh", "hosts.yml")
	mkdir(t, filepath.Dir(hosts))
	writeFile(t, hosts, "oauth_token: secret")
	link := filepath.Join(f.sub, "config-link")
	symlink(t, config, link)
	if _, _, err := f.svc.Read(ctx, hosts); !errors.Is(err, node.ErrDenied) {
		t.Fatalf("read before the rename: %v, want denied", err)
	}
	// wide allows the parent of home, so home is not a root there.
	wideGuard, err := NewGuard([]string{f.base}, f.user, f.serviceState)
	if err != nil {
		t.Fatal(err)
	}
	wide := New(wideGuard, Options{Logger: slog.New(slog.DiscardHandler)})
	moved := filepath.Join(f.sub, "moved")
	movedHome := filepath.Join(f.base, "moved-home")
	tests := []struct {
		name     string
		svc      *Service
		from, to string
	}{
		{"parent of a denied root", f.svc, config, moved},
		{"link to a parent of a denied root", f.svc, link, moved},
		{"home below the allowed root", wide, f.user, movedHome},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.svc.Rename(ctx, tt.from, tt.to)
			if !errors.Is(err, node.ErrDenied) {
				t.Fatalf("error = %v, want denied", err)
			}
			wantMessage(t, err, msgDenied)
		})
	}
	if exists(t, moved) || exists(t, movedHome) || readFile(t, hosts) != "oauth_token: secret" {
		t.Fatal("a refused rename moved something")
	}
	if _, _, err := f.svc.Read(ctx, filepath.Join(moved, "gh", "hosts.yml")); err == nil {
		t.Fatal("the token is readable under a new name")
	}

	// A sibling that only shares a prefix still moves.
	configx := filepath.Join(f.user, ".configx")
	mkdir(t, configx)
	if err := f.svc.Rename(ctx, configx, moved); err != nil {
		t.Fatalf("rename of .configx: %v", err)
	}
}

func TestOpen(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	p := filepath.Join(f.sub, "dl.txt")
	writeFile(t, p, "download")
	fh, err := f.svc.Open(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(fh)
	fh.Close()
	if err != nil || string(b) != "download" {
		t.Errorf("content = %q, %v", b, err)
	}

	fifo := filepath.Join(f.sub, "fifo")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		path string
		want error
	}{
		{"outside", filepath.Join(f.outside, "secret.txt"), node.ErrDenied},
		{"escape link", filepath.Join(f.escape, "secret.txt"), node.ErrDenied},
		{"denied", filepath.Join(f.ssh, "id_rsa"), node.ErrDenied},
		{"relative", "sub/dl.txt", node.ErrDenied},
		{"directory", f.sub, node.ErrNotFile},
		{"fifo", fifo, node.ErrNotFile},
		{"missing", filepath.Join(f.sub, "nope"), node.ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fh, err := f.svc.OpenFile(ctx, tt.path)
			if err != tt.want {
				t.Errorf("error = %v, want %v", err, tt.want)
			}
			if fh != nil {
				fh.Close()
				t.Error("got a file")
			}
		})
	}
}

// openRegular gets a resolved path. A link found there was swapped in
// after the guard ran. It must not be followed into a denied file.
func TestOpenRegularRefusesSwappedLink(t *testing.T) {
	f := newFixture(t)
	link := filepath.Join(f.sub, "swapped")
	symlink(t, filepath.Join(f.ssh, "id_rsa"), link)
	fh, _, err := openRegular(link)
	if err == nil {
		fh.Close()
		t.Fatal("openRegular followed the link")
	}
	if !errors.Is(err, syscall.ELOOP) {
		t.Errorf("error = %v, want ELOOP", err)
	}
}

// A symlink inside the root that points into a denied dir is refused by
// every operation.
func TestSymlinkIntoDeniedDir(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	key := filepath.Join(f.user, "key")
	symlink(t, filepath.Join(f.ssh, "id_rsa"), key)
	through := filepath.Join(f.shortcut, "id_rsa")
	for _, p := range []string{key, through} {
		checks := map[string]error{}
		_, checks["list"] = f.svc.List(ctx, f.shortcut)
		_, _, checks["read"] = f.svc.Read(ctx, p)
		_, checks["stat"] = f.svc.Stat(ctx, p)
		_, checks["write"] = f.svc.Write(ctx, p, "x")
		_, checks["open"] = f.svc.Open(ctx, p)
		_, checks["watch"] = f.svc.Watch(ctx, f.shortcut, nil)
		checks["upload"] = f.svc.NewUploads().Chunk(ctx, p, []byte("x"), true)
		checks["delete"] = f.svc.Delete(ctx, p)
		checks["rename"] = f.svc.Rename(ctx, p, filepath.Join(f.sub, "stolen"))
		for op, err := range checks {
			if !errors.Is(err, node.ErrDenied) {
				t.Errorf("%s %s: error = %v, want denied", op, p, err)
			}
		}
	}
	if got := readFile(t, filepath.Join(f.ssh, "id_rsa")); got != "-----BEGIN-----" {
		t.Errorf("key changed to %q", got)
	}
	if tmp := tempFiles(t, f.ssh); len(tmp) != 0 {
		t.Errorf("temp files in the denied dir: %q", tmp)
	}
}

// Port note 13: the browser gets short errno texts without the path.
func TestErrorMessagesHaveNoPath(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	file := filepath.Join(f.sub, "e.txt")
	writeFile(t, file, "x")
	missing := filepath.Join(f.sub, "missing")
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"read missing", second(f.svc.Read(ctx, missing)), "No such file or directory"},
		{"stat missing", errOf(f.svc.Stat(ctx, missing)), "No such file or directory"},
		{"list a file", errOf(f.svc.List(ctx, file)), "Not a directory"},
		{"create existing", f.svc.Create(ctx, file, ""), "File exists"},
		{"mkdir existing", f.svc.Mkdir(ctx, f.sub), "File exists"},
		{"delete missing", f.svc.Delete(ctx, missing), "No such file or directory"},
		{"write a directory", errOf(f.svc.Write(ctx, f.sub, "")), "Is a directory"},
		{"below a file", errOf(f.svc.Stat(ctx, filepath.Join(file, "x"))), "Not a directory"},
		{"denied", errOf(f.svc.Stat(ctx, f.ssh)), "Access denied: path outside allowed directories"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wantMessage(t, tt.err, tt.want)
			if strings.Contains(tt.err.Error(), f.base) {
				t.Errorf("message %q holds the path", tt.err.Error())
			}
		})
	}
}

func second[A, B any](_ A, _ B, err error) error { return err }

func errOf[A any](_ A, err error) error { return err }

func TestMessage(t *testing.T) {
	tests := []struct {
		err  error
		want string
	}{
		{nil, ""},
		{syscall.ENOENT, "No such file or directory"},
		{&fs.PathError{Op: "open", Path: "/secret/place", Err: syscall.EACCES}, "Permission denied"},
		{&os.LinkError{Op: "rename", Old: "/a", New: "/b", Err: syscall.EXDEV}, "Invalid cross-device link"},
		{&os.SyscallError{Syscall: "statx", Err: syscall.EPERM}, "Operation not permitted"},
		{syscall.ENOTEMPTY, "Directory not empty"},
		{node.ErrDenied, "Access denied: path outside allowed directories"},
		{node.ErrNotFile, "Not a file"},
		{&Error{msg: "own text", err: syscall.ENOENT}, "own text"},
		{errors.New("plain"), "plain"},
	}
	for _, tt := range tests {
		if got := Message(tt.err); got != tt.want {
			t.Errorf("Message(%v) = %q, want %q", tt.err, got, tt.want)
		}
	}
}

func TestCanceledContext(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	errs := []error{
		errOf(f.svc.List(ctx, f.sub)),
		second(f.svc.Read(ctx, f.sub)),
		errOf(f.svc.Stat(ctx, f.sub)),
		errOf(f.svc.Write(ctx, f.sub, "")),
		f.svc.Create(ctx, filepath.Join(f.sub, "c"), ""),
		f.svc.Mkdir(ctx, filepath.Join(f.sub, "m")),
		f.svc.Delete(ctx, f.sub),
		f.svc.Rename(ctx, f.sub, filepath.Join(f.user, "x")),
		errOf(f.svc.Open(ctx, f.sub)),
		errOf(f.svc.Watch(ctx, f.sub, nil)),
		f.svc.NewUploads().Chunk(ctx, filepath.Join(f.sub, "u"), nil, true),
	}
	for i, err := range errs {
		if !errors.Is(err, context.Canceled) {
			t.Errorf("call %d: error = %v, want context.Canceled", i, err)
		}
	}
	if !exists(t, f.sub) {
		t.Error("a canceled call changed the tree")
	}
}
