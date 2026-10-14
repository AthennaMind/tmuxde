package files

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tmuxde/internal/node"
)

func TestUploadChunks(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.svc.NewUploads()
	p := filepath.Join(f.sub, "up.bin")
	for i, chunk := range []string{"one ", "two ", "three"} {
		if err := u.Chunk(ctx, p, []byte(chunk), i == 2); err != nil {
			t.Fatal(err)
		}
	}
	if got := readFile(t, p); got != "one two three" {
		t.Errorf("content = %q", got)
	}
	fi, err := os.Stat(p)
	if want := umaskMode(t, f.sub, 0o666); err != nil || fi.Mode().Perm() != want {
		t.Errorf("mode = %v, want %v", fi.Mode().Perm(), want)
	}
	if tmp := tempFiles(t, f.sub); len(tmp) != 0 {
		t.Errorf("temp files left: %q", tmp)
	}
	if len(u.open) != 0 {
		t.Errorf("uploads still open: %v", u.open)
	}

	// A single final chunk, and an empty one.
	if err := u.Chunk(ctx, filepath.Join(f.sub, "one.bin"), []byte("x"), true); err != nil {
		t.Fatal(err)
	}
	if err := u.Chunk(ctx, filepath.Join(f.sub, "empty.bin"), nil, true); err != nil {
		t.Fatal(err)
	}
	if readFile(t, filepath.Join(f.sub, "one.bin")) != "x" || readFile(t, filepath.Join(f.sub, "empty.bin")) != "" {
		t.Error("single chunk uploads are wrong")
	}
}

// Port note 2: the target is only replaced by the final chunk. The relay
// truncated it on the first one.
func TestUploadReplacesTargetOnlyOnFinal(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.svc.NewUploads()
	p := filepath.Join(f.sub, "photo.jpg")
	writeFile(t, p, "original")
	if err := u.Chunk(ctx, p, []byte("new "), false); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, p); got != "original" {
		t.Errorf("target after the first chunk = %q", got)
	}
	tmp := tempFiles(t, f.sub)
	if len(tmp) != 1 || !strings.HasPrefix(tmp[0], ".photo.jpg.tmuxde-upload-") {
		t.Fatalf("temp files = %q", tmp)
	}
	if err := u.Chunk(ctx, p, []byte("data"), true); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, p); got != "new data" {
		t.Errorf("target after final = %q", got)
	}
	if tmp := tempFiles(t, f.sub); len(tmp) != 0 {
		t.Errorf("temp files left: %q", tmp)
	}
}

// Port note 2: an interrupted upload and the disconnect cleanup leave the
// original target as it was. The relay deleted it.
func TestUploadInterruptKeepsTarget(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.svc.NewUploads()
	existing := filepath.Join(f.sub, "keep.txt")
	fresh := filepath.Join(f.sub, "fresh.txt")
	writeFile(t, existing, "original")
	if err := u.Chunk(ctx, existing, []byte("partial"), false); err != nil {
		t.Fatal(err)
	}
	if err := u.Chunk(ctx, fresh, []byte("partial"), false); err != nil {
		t.Fatal(err)
	}
	if n := len(tempFiles(t, f.sub)); n != 2 {
		t.Fatalf("%d temp files, want 2", n)
	}
	u.Cleanup()
	if got := readFile(t, existing); got != "original" {
		t.Errorf("target = %q, want original", got)
	}
	if exists(t, fresh) {
		t.Error("cleanup created the new target")
	}
	if tmp := tempFiles(t, f.sub); len(tmp) != 0 {
		t.Errorf("temp files left: %q", tmp)
	}
	u.Cleanup()
}

func TestUploadTooLarge(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	p := filepath.Join(f.sub, "big.bin")
	writeFile(t, p, "original")
	u := f.svc.NewUploads()
	err := u.Chunk(ctx, p, make([]byte, DefaultUploadLimit+1), true)
	wantMessage(t, err, "Upload too large (10485761 bytes, max 10485760)")
	if got := readFile(t, p); got != "original" {
		t.Errorf("target changed to %d bytes", len(got))
	}
	// A final chunk that fails ends its upload. Nothing is left to refuse
	// the next one.
	if len(u.open)+len(u.failed) != 0 {
		t.Errorf("open %v, failed %v, want none", u.open, u.failed)
	}
	if err := u.Chunk(ctx, p, []byte("small"), true); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, p); got != "small" {
		t.Errorf("target = %q, want small", got)
	}
}

// The browser sends chunks back to back without waiting for replies. When
// one fails, the rest of that upload must fail too. Before, the next chunk
// started a new upload and the final rename put only the tail over the
// target.
func TestUploadFailureAbortsTheRest(t *testing.T) {
	tests := []struct {
		name  string
		limit int64
		// asRoot is false when the case relies on permission bits.
		asRoot bool
		// fail sends chunks of one upload until one fails and returns
		// that error.
		fail func(t *testing.T, f *fixture, u *Uploads, p string) error
		want string
	}{
		{
			name:   "too large over several chunks",
			limit:  10,
			asRoot: true,
			fail: func(t *testing.T, f *fixture, u *Uploads, p string) error {
				mustChunk(t, u, p, "123456", false)
				return u.Chunk(context.Background(), p, []byte("789012"), false)
			},
			want: "Upload too large (12 bytes, max 10)",
		},
		{
			name:   "failed append",
			asRoot: true,
			fail: func(t *testing.T, f *fixture, u *Uploads, p string) error {
				mustChunk(t, u, p, "one", false)
				for _, tmp := range tempFiles(t, f.sub) {
					if err := os.Remove(filepath.Join(f.sub, tmp)); err != nil {
						t.Fatal(err)
					}
				}
				return u.Chunk(context.Background(), p, []byte("two"), false)
			},
			want: "No such file or directory",
		},
		{
			// The directory is writable again right after the failure, so
			// a later chunk could make a temp file if it were let through.
			name: "failed first chunk",
			fail: func(t *testing.T, f *fixture, u *Uploads, p string) error {
				if err := os.Chmod(f.sub, 0o555); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Chmod(f.sub, 0o755) })
				err := u.Chunk(context.Background(), p, []byte("one"), false)
				if err := os.Chmod(f.sub, 0o755); err != nil {
					t.Fatal(err)
				}
				return err
			},
			want: "Permission denied",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if !tt.asRoot {
				skipIfRoot(t)
			}
			f := newFixture(t)
			ctx := context.Background()
			svc := New(f.guard, Options{UploadLimit: tt.limit, Logger: slog.New(slog.DiscardHandler)})
			u := svc.NewUploads()
			p := filepath.Join(f.sub, "target.bin")
			writeFile(t, p, "original")

			err := tt.fail(t, f, u, p)
			wantMessage(t, err, tt.want)
			if errors.Is(err, ErrUploadAborted) {
				t.Error("the first failure is marked aborted")
			}
			if tmp := tempFiles(t, f.sub); len(tmp) != 0 {
				t.Errorf("temp files left: %q", tmp)
			}

			// The rest of the upload fails with the same text and makes
			// no temp file.
			err = u.Chunk(ctx, p, []byte("rest"), false)
			wantMessage(t, err, tt.want)
			if !errors.Is(err, ErrUploadAborted) {
				t.Errorf("error = %v, want ErrUploadAborted", err)
			}
			if tmp := tempFiles(t, f.sub); len(tmp) != 0 {
				t.Errorf("temp files left: %q", tmp)
			}

			// Another target is not affected.
			other := filepath.Join(f.sub, "other.bin")
			mustChunk(t, u, other, "ok", true)
			if got := readFile(t, other); got != "ok" {
				t.Errorf("other target = %q", got)
			}

			// The final chunk returns the first error and ends the
			// upload.
			err = u.Chunk(ctx, p, []byte("end"), true)
			wantMessage(t, err, tt.want)
			if errors.Is(err, ErrUploadAborted) {
				t.Error("the final chunk is marked aborted")
			}
			if got := readFile(t, p); got != "original" {
				t.Errorf("target = %q, want original", got)
			}
			if len(u.open)+len(u.failed) != 0 {
				t.Errorf("open %v, failed %v, want none", u.open, u.failed)
			}

			// The next upload starts from zero.
			mustChunk(t, u, p, "abcd", false)
			mustChunk(t, u, p, "ef", true)
			if got := readFile(t, p); got != "abcdef" {
				t.Errorf("target = %q, want abcdef", got)
			}
		})
	}
}

// A chunk that comes after Cleanup is refused. It would leave a temp file
// that nothing removes, and a final one would replace the target with a
// part of the upload.
func TestUploadAfterCleanup(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.svc.NewUploads()
	p := filepath.Join(f.sub, "late.bin")
	writeFile(t, p, "original")
	mustChunk(t, u, p, "one", false)
	u.Cleanup()
	for _, final := range []bool{false, true} {
		err := u.Chunk(ctx, p, []byte("two"), final)
		wantMessage(t, err, "Upload failed")
		if !errors.Is(err, errUploadsClosed) {
			t.Errorf("final %v: error = %v, want errUploadsClosed", final, err)
		}
	}
	if got := readFile(t, p); got != "original" {
		t.Errorf("target = %q, want original", got)
	}
	if tmp := tempFiles(t, f.sub); len(tmp) != 0 {
		t.Errorf("temp files left: %q", tmp)
	}
}

func TestUploadFinalRenameFails(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.svc.NewUploads()
	p := filepath.Join(f.sub, "late-dir")
	if err := u.Chunk(ctx, p, []byte("x"), false); err != nil {
		t.Fatal(err)
	}
	mkdir(t, filepath.Join(p, "inside"))
	if err := u.Chunk(ctx, p, []byte("y"), true); err == nil {
		t.Fatal("rename over a directory passed")
	}
	if tmp := tempFiles(t, f.sub); len(tmp) != 0 {
		t.Errorf("temp files left: %q", tmp)
	}
	if !exists(t, filepath.Join(p, "inside")) {
		t.Error("the directory was touched")
	}
	wantMessage(t, u.Chunk(ctx, p, []byte("z"), true), "Is a directory")
}

// Uploads are per connection. Cleanup of one leaves the other alone.
func TestUploadsArePerConnection(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	a, b := f.svc.NewUploads(), f.svc.NewUploads()
	p := filepath.Join(f.sub, "shared.bin")
	if err := a.Chunk(ctx, p, []byte("aaa"), false); err != nil {
		t.Fatal(err)
	}
	if err := b.Chunk(ctx, p, []byte("bbb"), false); err != nil {
		t.Fatal(err)
	}
	a.Cleanup()
	if err := b.Chunk(ctx, p, []byte("!"), true); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, p); got != "bbb!" {
		t.Errorf("target = %q, want bbb!", got)
	}
}

func TestUploadDenied(t *testing.T) {
	f := newFixture(t)
	u := f.svc.NewUploads()
	for _, p := range []string{
		filepath.Join(f.ssh, "authorized_keys"),
		filepath.Join(f.outside, "drop.bin"),
		filepath.Join(f.escape, "drop.bin"),
	} {
		if err := u.Chunk(context.Background(), p, []byte("x"), true); !errors.Is(err, node.ErrDenied) {
			t.Errorf("Chunk(%q) error = %v, want denied", p, err)
		}
	}
	if exists(t, filepath.Join(f.ssh, "authorized_keys")) || exists(t, filepath.Join(f.outside, "drop.bin")) {
		t.Error("a denied upload wrote a file")
	}
	if len(tempFiles(t, f.ssh))+len(tempFiles(t, f.outside)) != 0 {
		t.Error("a denied upload left a temp file")
	}
}

func TestUploadLongName(t *testing.T) {
	f := newFixture(t)
	name := strings.Repeat("n", 250)
	p := filepath.Join(f.sub, name)
	u := f.svc.NewUploads()
	if err := u.Chunk(context.Background(), p, []byte("x"), false); err != nil {
		t.Fatal(err)
	}
	if err := u.Chunk(context.Background(), p, []byte("y"), true); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, p); got != "xy" {
		t.Errorf("content = %q", got)
	}
}

func mustChunk(t *testing.T, u *Uploads, path, data string, final bool) {
	t.Helper()
	if err := u.Chunk(context.Background(), path, []byte(data), final); err != nil {
		t.Fatalf("Chunk(%q, final %v): %v", data, final, err)
	}
}
