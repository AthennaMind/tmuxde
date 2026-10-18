package local

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"tmuxde/internal/config"
	"tmuxde/internal/node"
	"tmuxde/internal/node/files"
	"tmuxde/internal/node/repo"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// fakeRepo records repository requests and answers from its fields.
type fakeRepo struct {
	mu     sync.Mutex
	calls  []repoCall
	result protocol.RepoResult

	// roots maps a pane folder to the root WatchRoot finds. A missing
	// folder is the error rootErr, or a plain folder.
	roots   map[string]string
	rootErr error
	// watchErr fails Watch.
	watchErr error
	// partial is what new watches report.
	partial bool
	// watches holds every watch Watch started, in order.
	watches []*fakeWatch
	// rootCalls records the folder and context path of each WatchRoot.
	rootCalls []string
}

// fakeWatch is a watch of fakeRepo. Send pushes a change as the real one
// would.
type fakeWatch struct {
	root    string
	partial bool
	send    func(server.Message)
	mu      sync.Mutex
	closed  int
}

func (w *fakeWatch) Partial() bool { return w.partial }

func (w *fakeWatch) Close() error {
	w.mu.Lock()
	w.closed++
	w.mu.Unlock()
	return nil
}

func (w *fakeWatch) isClosed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.closed > 0
}

func (r *fakeRepo) WatchRoot(_ context.Context, cwd string, path *string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	call := cwd
	if path != nil {
		call += "|" + *path
	}
	r.rootCalls = append(r.rootCalls, call)
	if r.rootErr != nil {
		return "", r.rootErr
	}
	start := cwd
	if path != nil {
		start = *path
	}
	root, ok := r.roots[start]
	if !ok {
		return "", errors.New("not a repository")
	}
	return root, nil
}

func (r *fakeRepo) Watch(_ context.Context, root string, send func(server.Message)) (repo.WatchHandle, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.watchErr != nil {
		return nil, r.watchErr
	}
	w := &fakeWatch{root: root, partial: r.partial, send: send}
	r.watches = append(r.watches, w)
	return w, nil
}

func (r *fakeRepo) started() []*fakeWatch {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.watches)
}

type repoCall struct {
	cwd string
	req *client.RepoRequest
}

func (r *fakeRepo) Request(_ context.Context, cwd string, req *client.RepoRequest) *server.RepoResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, repoCall{cwd, req})
	if e, ok := r.result.(*protocol.RepoError); ok {
		return repo.ErrorResult(req.RequestID, e.Message)
	}
	return &server.RepoResult{Type: "repo:result", RequestID: req.RequestID, Result: r.result}
}

func (r *fakeRepo) called() []repoCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.calls)
}

// fileHarness is a harness over fake tmux with the real file service on a
// temp dir and a fake repository service.
type fileHarness struct {
	*harness
	// root is the one allowed path, with symlinks resolved. It is also
	// the home, so root/.ssh is denied.
	root string
	// outside is a temp dir outside every allowed path.
	outside string
	repo    *fakeRepo
}

func newFileHarness(t *testing.T) *fileHarness {
	t.Helper()
	return newFileHarnessWith(t, files.Options{Logger: quiet})
}

// newFileHarnessWith is newFileHarness with file service options.
func newFileHarnessWith(t *testing.T, opts files.Options) *fileHarness {
	t.Helper()
	root := realDir(t)
	guard, err := files.NewGuard([]string{root}, root, "")
	if err != nil {
		t.Fatal(err)
	}
	fh := &fileHarness{
		root:    root,
		outside: realDir(t),
		repo:    &fakeRepo{result: &protocol.RepoContext{Kind: "context", Path: "/fresh/path"}},
	}
	fh.harness = newHarnessWith(t, func(d *Deps) {
		d.Files = files.New(guard, opts)
		d.Repo = fh.repo
	})
	return fh
}

// realDir is a temp dir with symlinks resolved, as the file service
// reports paths.
func realDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func (fh *fileHarness) path(parts ...string) string {
	return filepath.Join(append([]string{fh.root}, parts...)...)
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

// only returns the one message the sink got since the last reset.
func only[T server.Message](t *testing.T, sink *fakeSink) T {
	t.Helper()
	all := sink.all()
	if len(all) != 1 {
		t.Fatalf("sink has %v, want one message", typesOf(all))
	}
	m, ok := all[0].(T)
	if !ok {
		t.Fatalf("sink has %s", all[0].WireType())
	}
	sink.reset()
	return m
}

func wantOp(t *testing.T, got *server.FileOpResult, op, path string, errText string) {
	t.Helper()
	if got.Op != op || got.Path != path {
		t.Fatalf("file:op:result = %+v, want op %s path %s", got, op, path)
	}
	switch {
	case errText == "" && (!got.Success || got.Error != nil):
		t.Fatalf("file:op:result %s failed: %v", op, deref(got.Error))
	case errText != "" && (got.Success || got.Error == nil || *got.Error != errText):
		t.Fatalf("file:op:result %s = success %v error %q, want error %q", op, got.Success, deref(got.Error), errText)
	}
}

func deref[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

// TestFileGuard checks that the router refuses a denied path before the
// file service runs, with ACCESS_DENIED and the relay text.
func TestFileGuard(t *testing.T) {
	fh := newFileHarness(t)
	sink := fh.open(1)
	if err := os.Mkdir(fh.path(".ssh"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, fh.path(".ssh", "id_rsa"), "KEY")
	writeFile(t, filepath.Join(fh.outside, "secret.txt"), "SECRET")
	writeFile(t, fh.path("ok.txt"), "OK")
	if err := os.Symlink(fh.outside, fh.path("escape")); err != nil {
		t.Fatal(err)
	}

	denied := []struct {
		name, path string
		// readOnly sends only messages that change nothing. Relative
		// paths resolve against the working directory, which is the
		// package source, so nothing may try to write there.
		readOnly bool
	}{
		{name: "outside", path: filepath.Join(fh.outside, "secret.txt")},
		{name: "credential dir", path: fh.path(".ssh", "id_rsa")},
		{name: "symlink escape", path: fh.path("escape", "secret.txt")},
		{name: "dot dot traversal", path: fh.root + "/../" + filepath.Base(fh.outside) + "/secret.txt"},
		{name: "relative", path: "ok.txt", readOnly: true},
		{name: "empty", path: "", readOnly: true},
	}
	for _, d := range denied {
		p := d.path
		msgs := []client.Message{
			&client.FileList{Type: "file:list", Path: p},
			&client.FileRead{Type: "file:read", Path: p},
			&client.FileStat{Type: "file:stat", Path: p},
			&client.FileWatch{Type: "file:watch", Path: p},
		}
		if !d.readOnly {
			msgs = append(msgs,
				&client.FileWrite{Type: "file:write", Path: p, Content: "x"},
				&client.FileCreate{Type: "file:create", Path: p},
				&client.FileMkdir{Type: "file:mkdir", Path: p},
				&client.FileDelete{Type: "file:delete", Path: p},
				&client.FileUpload{Type: "file:upload", Path: p, Content: "eA==", Final: true},
				&client.FileRename{Type: "file:rename", OldPath: p, NewPath: fh.path("moved.txt")},
				&client.FileRename{Type: "file:rename", OldPath: fh.path("ok.txt"), NewPath: p},
			)
		}
		for _, msg := range msgs {
			fh.must(1, msg)
			all := sink.all()
			if len(all) != 1 {
				t.Fatalf("%s %s: sink has %v, want one error", d.name, msg.WireType(), typesOf(all))
			}
			wantError(t, all[0], CodeAccessDenied, "Path outside allowed directories")
			sink.reset()
		}
	}
	if got := readFile(t, fh.path(".ssh", "id_rsa")); got != "KEY" {
		t.Fatalf("credential file changed to %q", got)
	}
	if got := readFile(t, filepath.Join(fh.outside, "secret.txt")); got != "SECRET" {
		t.Fatalf("outside file changed to %q", got)
	}
	if got := readFile(t, fh.path("ok.txt")); got != "OK" {
		t.Fatalf("ok.txt changed to %q", got)
	}
	if _, err := os.Lstat(fh.path("moved.txt")); err == nil {
		t.Fatal("a denied rename moved ok.txt")
	}
	// file:unwatch is never guarded and never answers.
	fh.must(1, &client.FileUnwatch{Type: "file:unwatch", Path: filepath.Join(fh.outside, "x")})
	if got := sink.all(); len(got) != 0 {
		t.Fatalf("unwatch answered %v", typesOf(got))
	}
}

// TestFileReplies checks the exact reply of every file message.
func TestFileReplies(t *testing.T) {
	fh := newFileHarness(t)
	sink := fh.open(1)
	writeFile(t, fh.path("b.txt"), "bee")
	if err := os.Mkdir(fh.path("dir"), 0o755); err != nil {
		t.Fatal(err)
	}

	// The reply echoes the path as sent. Entries carry the real path.
	sent := fh.root + "/"
	fh.must(1, &client.FileList{Type: "file:list", Path: sent})
	list := only[*server.FileList](t, sink)
	if list.Path != sent || len(list.Entries) != 2 {
		t.Fatalf("file:list = %+v", list)
	}
	if e := list.Entries[0]; e.Name != "dir" || e.Type != "directory" || e.Path != fh.path("dir") {
		t.Fatalf("first entry = %+v", e)
	}
	if e := list.Entries[1]; e.Name != "b.txt" || e.Type != "file" || e.Size != 3 {
		t.Fatalf("second entry = %+v", e)
	}

	// An empty directory lists as [], never null.
	fh.must(1, &client.FileList{Type: "file:list", Path: fh.path("dir")})
	if got := only[*server.FileList](t, sink); got.Entries == nil || len(got.Entries) != 0 {
		t.Fatalf("empty dir = %+v", got)
	}

	fh.must(1, &client.FileRead{Type: "file:read", Path: fh.path("b.txt")})
	if got := only[*server.FileContent](t, sink); got.Path != fh.path("b.txt") || got.Content != "bee" || got.Truncated {
		t.Fatalf("file:content = %+v", got)
	}

	fh.must(1, &client.FileStat{Type: "file:stat", Path: fh.path("b.txt")})
	if st := only[*server.FileStat](t, sink).Stat; st.Name != "b.txt" || st.Type != "file" || st.Size != 3 || st.Permissions != "rw" || !st.IsReadable || !st.IsWritable {
		t.Fatalf("file:stat = %+v", st)
	}

	// Unexpected failures in list, read and stat return the short text for
	// the hub's HANDLER_ERROR. Nothing is sent.
	missing := fh.path("missing")
	for _, msg := range []client.Message{
		&client.FileList{Type: "file:list", Path: missing},
		&client.FileRead{Type: "file:read", Path: missing},
		&client.FileStat{Type: "file:stat", Path: missing},
	} {
		err := fh.handle(1, msg)
		if err == nil || err.Error() != "No such file or directory" || !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s missing = %v", msg.WireType(), err)
		}
	}
	if err := fh.handle(1, &client.FileRead{Type: "file:read", Path: fh.path("dir")}); err == nil || err.Error() != "Not a file" {
		t.Fatalf("read of a directory = %v", err)
	}
	if got := sink.all(); len(got) != 0 {
		t.Fatalf("failures sent %v", typesOf(got))
	}

	fh.must(1, &client.FileWrite{Type: "file:write", Path: fh.path("b.txt"), Content: "written \u00e9"})
	w := only[*server.FileWriteResult](t, sink)
	if !w.Success || w.Path != fh.path("b.txt") || w.Size == nil || *w.Size != 10 || w.Error != nil {
		t.Fatalf("file:write:result = %+v", w)
	}
	if got := readFile(t, fh.path("b.txt")); got != "written \u00e9" {
		t.Fatalf("b.txt = %q", got)
	}
	// Write cannot create, as in the relay.
	fh.must(1, &client.FileWrite{Type: "file:write", Path: fh.path("new.txt"), Content: "x"})
	w = only[*server.FileWriteResult](t, sink)
	if w.Success || w.Size != nil || w.Error == nil || *w.Error != "No such file or directory" {
		t.Fatalf("write of a missing file = %+v", w)
	}

	fh.must(1, &client.FileCreate{Type: "file:create", Path: fh.path("new.txt"), Content: ptr("fresh")})
	wantOp(t, only[*server.FileOpResult](t, sink), "create", fh.path("new.txt"), "")
	fh.must(1, &client.FileCreate{Type: "file:create", Path: fh.path("new.txt")})
	wantOp(t, only[*server.FileOpResult](t, sink), "create", fh.path("new.txt"), "File exists")
	if got := readFile(t, fh.path("new.txt")); got != "fresh" {
		t.Fatalf("new.txt = %q", got)
	}
	fh.must(1, &client.FileCreate{Type: "file:create", Path: fh.path("empty.txt")})
	wantOp(t, only[*server.FileOpResult](t, sink), "create", fh.path("empty.txt"), "")

	fh.must(1, &client.FileMkdir{Type: "file:mkdir", Path: fh.path("made")})
	wantOp(t, only[*server.FileOpResult](t, sink), "mkdir", fh.path("made"), "")
	fh.must(1, &client.FileMkdir{Type: "file:mkdir", Path: fh.path("made")})
	wantOp(t, only[*server.FileOpResult](t, sink), "mkdir", fh.path("made"), "File exists")

	fh.must(1, &client.FileRename{Type: "file:rename", OldPath: fh.path("new.txt"), NewPath: fh.path("made", "renamed.txt")})
	wantOp(t, only[*server.FileOpResult](t, sink), "rename", fh.path("made", "renamed.txt"), "")
	fh.must(1, &client.FileRename{Type: "file:rename", OldPath: fh.path("new.txt"), NewPath: fh.path("again.txt")})
	wantOp(t, only[*server.FileOpResult](t, sink), "rename", fh.path("again.txt"), "No such file or directory")

	fh.must(1, &client.FileDelete{Type: "file:delete", Path: fh.path("made")})
	wantOp(t, only[*server.FileOpResult](t, sink), "delete", fh.path("made"), "")
	fh.must(1, &client.FileDelete{Type: "file:delete", Path: fh.path("made")})
	wantOp(t, only[*server.FileOpResult](t, sink), "delete", fh.path("made"), "No such file or directory")
	fh.must(1, &client.FileDelete{Type: "file:delete", Path: fh.root})
	wantOp(t, only[*server.FileOpResult](t, sink), "delete", fh.root, "Cannot delete an allowed root directory")
}

// TestUploadAcks ports "upload acknowledgements" and "photo upload
// completion" of message-router.test.ts, plus the error reply.
func TestUploadAcks(t *testing.T) {
	tests := []struct {
		name    string
		final   bool
		ack     *bool
		replies int
		// wantFinal is the final field of the reply, nil when absent.
		wantFinal *bool
	}{
		{name: "acknowledges nonfinal chunks only when requested", ack: ptr(true), replies: 1, wantFinal: ptr(false)},
		{name: "keeps legacy intermediate chunks silent"},
		{name: "ack false is legacy too", ack: ptr(false)},
		{name: "acknowledges final chunk after write succeeds", final: true, ack: ptr(true), replies: 1, wantFinal: ptr(true)},
		{name: "answers a legacy final chunk without final", final: true, replies: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fh := newFileHarness(t)
			sink := fh.open(1)
			target := fh.path("photo.png")
			fh.must(1, &client.FileUpload{Type: "file:upload", Path: target, Content: "YQ==", Final: tt.final, Ack: tt.ack})
			all := sink.all()
			if len(all) != tt.replies {
				t.Fatalf("replies %v, want %d", typesOf(all), tt.replies)
			}
			if tt.replies == 1 {
				got := all[0].(*server.FileOpResult)
				wantOp(t, got, "upload", target, "")
				if !equalPtr(got.Final, tt.wantFinal) {
					t.Fatalf("final = %v, want %v", deref(got.Final), deref(tt.wantFinal))
				}
			}
			_, err := os.Stat(target)
			if tt.final && err != nil {
				t.Fatalf("final chunk left no file: %v", err)
			}
			if !tt.final && err == nil {
				t.Fatal("a nonfinal chunk wrote the target")
			}
		})
	}

	t.Run("reports a failed chunk", func(t *testing.T) {
		fh := newFileHarness(t)
		sink := fh.open(1)
		// The parent does not exist, so the temp file cannot be made.
		target := fh.path("nodir", "photo.png")
		fh.must(1, &client.FileUpload{Type: "file:upload", Path: target, Content: "YQ==", Final: false})
		got := only[*server.FileOpResult](t, sink)
		wantOp(t, got, "upload", target, "No such file or directory")
		if got.Final != nil {
			t.Fatalf("error reply has final %v", *got.Final)
		}
	})
}

func equalPtr[T comparable](a, b *T) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// TestUploadChunks sends three chunks and checks that the target changes
// only with the last.
func TestUploadChunks(t *testing.T) {
	fh := newFileHarness(t)
	sink := fh.open(1)
	target := fh.path("data.bin")
	writeFile(t, target, "ORIGINAL")
	for i, chunk := range []string{"b25l", "dHdv", "dGhyZWU="} {
		final := i == 2
		fh.must(1, &client.FileUpload{Type: "file:upload", Path: target, Content: chunk, Final: final, Ack: ptr(true)})
		wantOp(t, only[*server.FileOpResult](t, sink), "upload", target, "")
		want := "ORIGINAL"
		if final {
			want = "onetwothree"
		}
		if got := readFile(t, target); got != want {
			t.Fatalf("after chunk %d target = %q, want %q", i, got, want)
		}
	}
	if left := tempFiles(t, fh.root); len(left) != 0 {
		t.Fatalf("temp files left: %v", left)
	}
}

// TestUploadRejectedChunk sends an upload the way the browser does, chunk
// after chunk without waiting for replies. The third chunk passes the
// limit. The rest of the upload must fail, and the target must keep its
// content. Before, the fourth chunk started a new upload and the final
// chunk put "DDEE" over the target with a success reply.
func TestUploadRejectedChunk(t *testing.T) {
	const tooLarge = "Upload too large (12 bytes, max 10)"
	tests := []struct {
		name string
		ack  *bool
		// want holds the error text of each reply in order. Empty is a
		// success.
		want []string
	}{
		{
			// Chunk four is refused silently. The error was reported on
			// chunk three and again on the final chunk.
			name: "plain chunks",
			want: []string{tooLarge, tooLarge},
		},
		{
			name: "acknowledged chunks",
			ack:  ptr(true),
			want: []string{"", "", tooLarge, tooLarge, tooLarge},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fh := newFileHarnessWith(t, files.Options{UploadLimit: 10, Logger: quiet})
			sink := fh.open(1)
			target := fh.path("data.bin")
			writeFile(t, target, "original")
			chunks := []string{"AAAA", "BBBB", "CCCC", "DD", "EE"}
			for i, chunk := range chunks {
				fh.must(1, &client.FileUpload{
					Type:    "file:upload",
					Path:    target,
					Content: base64.StdEncoding.EncodeToString([]byte(chunk)),
					Final:   i == len(chunks)-1,
					Ack:     tt.ack,
				})
			}
			all := sink.all()
			if len(all) != len(tt.want) {
				t.Fatalf("replies %v, want %d", typesOf(all), len(tt.want))
			}
			for i, m := range all {
				res, ok := m.(*server.FileOpResult)
				if !ok {
					t.Fatalf("reply %d is %s", i, m.WireType())
				}
				wantOp(t, res, "upload", target, tt.want[i])
			}
			if got := readFile(t, target); got != "original" {
				t.Fatalf("target = %q, want original", got)
			}
			if left := tempFiles(t, fh.root); len(left) != 0 {
				t.Fatalf("temp files left: %v", left)
			}

			// The next upload of the same path starts from zero.
			sink.reset()
			fh.must(1, &client.FileUpload{Type: "file:upload", Path: target, Content: "YWJj", Final: true})
			wantOp(t, only[*server.FileOpResult](t, sink), "upload", target, "")
			if got := readFile(t, target); got != "abc" {
				t.Fatalf("target = %q, want abc", got)
			}
		})
	}
}

// TestCloseCleansUploads ports the disconnect cleanup with the decided
// fix: the temp file goes, the original stays.
func TestCloseCleansUploads(t *testing.T) {
	fh := newFileHarness(t)
	sink := fh.open(1)
	target := fh.path("keep.txt")
	writeFile(t, target, "ORIGINAL")
	fh.must(1, &client.FileUpload{Type: "file:upload", Path: target, Content: "cGFydA==", Ack: ptr(true)})
	only[*server.FileOpResult](t, sink)
	if left := tempFiles(t, fh.root); len(left) != 1 {
		t.Fatalf("temp files during the upload: %v, want one", left)
	}
	fh.n.Close(1)
	if left := tempFiles(t, fh.root); len(left) != 0 {
		t.Fatalf("temp files after Close: %v", left)
	}
	if got := readFile(t, target); got != "ORIGINAL" {
		t.Fatalf("target = %q after an interrupted upload", got)
	}
}

func tempFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmuxde-upload-") {
			out = append(out, e.Name())
		}
	}
	return out
}

// TestDecodeBase64 checks parity with Buffer.from(s, "base64") in Node.
// The wanted bytes were printed by Node 24.
func TestDecodeBase64(t *testing.T) {
	tests := []struct{ in, hex string }{
		{"", ""},
		{"YQ==", "61"},
		{"YQ", "61"},
		{"YR", "61"},
		{"YWJj", "616263"},
		{"YWJjZ", "616263"},
		{"YWJjZA", "61626364"},
		{"YWJjZA==", "61626364"},
		{"YQ==YQ==", "61"},
		{"YWJj=ZGVm", "616263"},
		{"YW Jj\r\nZA", "61626364"},
		{"YW!Jj", "616263"},
		{"-_8=", "fbff"},
		{"+/8=", "fbff"},
		{"Y", ""},
		{"####", ""},
		{"8J+YgA==", "f09f9880"},
	}
	for _, tt := range tests {
		if got := hex.EncodeToString(decodeBase64(tt.in)); got != tt.hex {
			t.Errorf("decodeBase64(%q) = %s, want %s", tt.in, got, tt.hex)
		}
	}
}

// TestWatchers covers file:watch and file:unwatch on one connection.
func TestWatchers(t *testing.T) {
	fh := newFileHarness(t)
	fh.n.maxWatchers = 2
	sink := fh.open(1)
	c := fh.conn(1)
	dir := fh.path("watched")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Success sends nothing, and a second watch of the same text is a
	// no op.
	fh.must(1, &client.FileWatch{Type: "file:watch", Path: dir})
	fh.must(1, &client.FileWatch{Type: "file:watch", Path: dir})
	if got := sink.all(); len(got) != 0 {
		t.Fatalf("watch answered %v", typesOf(got))
	}
	c.mu.Lock()
	n := len(c.watchers)
	c.mu.Unlock()
	if n != 1 {
		t.Fatalf("watchers = %d, want 1", n)
	}

	writeFile(t, filepath.Join(dir, "new.txt"), "x")
	sink.waitFor(func(m []server.Message) bool {
		return slices.ContainsFunc(m, func(msg server.Message) bool {
			c, ok := msg.(*server.FileChanged)
			return ok && c.Path == filepath.Join(dir, "new.txt") && c.Event == "add"
		})
	})

	fh.must(1, &client.FileUnwatch{Type: "file:unwatch", Path: dir})
	fh.must(1, &client.FileUnwatch{Type: "file:unwatch", Path: dir})
	c.mu.Lock()
	n = len(c.watchers)
	c.mu.Unlock()
	if n != 0 {
		t.Fatalf("watchers after unwatch = %d", n)
	}

	sink.reset()
	// A file is not a directory. The error is the short text.
	fh.must(1, &client.FileWatch{Type: "file:watch", Path: filepath.Join(dir, "new.txt")})
	wantError(t, only[server.Message](t, sink), CodeWatchFailed, "Not a directory")
	fh.must(1, &client.FileWatch{Type: "file:watch", Path: fh.path("missing")})
	wantError(t, only[server.Message](t, sink), CodeWatchFailed, "No such file or directory")

	// The cap counts distinct paths. A duplicate is still a no op. sub
	// is made while nothing watches dir, so no event joins the replies.
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	fh.must(1, &client.FileWatch{Type: "file:watch", Path: dir})
	fh.must(1, &client.FileWatch{Type: "file:watch", Path: fh.root})
	fh.must(1, &client.FileWatch{Type: "file:watch", Path: dir})
	if got := sink.all(); len(got) != 0 {
		t.Fatalf("watches under the cap answered %v", typesOf(got))
	}
	fh.must(1, &client.FileWatch{Type: "file:watch", Path: sub})
	wantError(t, only[server.Message](t, sink), CodeWatchFailed, "Too many watchers")

	// Close takes every watcher.
	fh.n.Close(1)
	c.mu.Lock()
	left := len(c.watchers)
	c.mu.Unlock()
	if left != 0 {
		t.Fatalf("watchers after Close = %d", left)
	}
}

// TestWatchAfterClose runs a watch after Close, as a message the hub
// still had queued past its drain timeout can. No watcher may stay.
func TestWatchAfterClose(t *testing.T) {
	fh := newFileHarness(t)
	fh.open(1)
	c := fh.conn(1)
	fh.n.Close(1)
	// Handle refuses a closed connection, so call the handler as a queued
	// message would run after Close.
	if err := fh.n.fileWatch(context.Background(), c, fh.root); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.watchers) != 0 {
		t.Fatalf("watcher kept after Close: %v", c.watchers)
	}
}

// Ported from message-router.test.ts, describe "repository request
// routing", with the refusals the Go router adds.
func TestRepoRequestRouting(t *testing.T) {
	withPath := func(id, dir string) protocol.PaneInfo {
		p := pane(id, "@1")
		if dir != "" {
			p.Path = &dir
		}
		return p
	}

	t.Run("uses fresh pane directory instead of browser context", func(t *testing.T) {
		fh := newFileHarness(t)
		sink := fh.open(1)
		fh.setAttached(1, "work")
		fh.tm.set(func(f *fakeTmux) { f.panes = []protocol.PaneInfo{withPath("%1", "/fresh/path")} })
		req := &client.RepoRequest{Type: "repo:request", RequestID: "context-1", ID: "%1", Action: "context", Path: ptr("/stale/path")}
		fh.must(1, req)
		calls := fh.repo.called()
		if len(calls) != 1 || calls[0].cwd != "/fresh/path" || calls[0].req != req {
			t.Fatalf("repository calls = %+v", calls)
		}
		got := only[*server.RepoResult](t, sink)
		if c, ok := got.Result.(*protocol.RepoContext); !ok || got.RequestID != "context-1" || c.Path != "/fresh/path" {
			t.Fatalf("repo:result = %+v", got)
		}
		// One unscoped listing gives the owner check and the directory.
		if got := fh.tm.called("ListPanes"); !slices.Equal(got, []string{"ListPanes work "}) {
			t.Fatalf("ListPanes calls = %v", got)
		}
	})

	refusals := []struct {
		name     string
		attached string
		panes    []protocol.PaneInfo
		listErr  error
		id       string
		want     string
	}{
		{name: "correlates a missing attach", id: "%1", want: "No session attached"},
		{name: "refuses panes outside attached session", attached: "work", panes: []protocol.PaneInfo{withPath("%1", "/w")}, id: "%9", want: `Pane "%9" not found`},
		{name: "refuses when the pane lookup fails", attached: "work", listErr: errBoom, id: "%1", want: `Pane "%1" not found`},
		{name: "refuses a pane without a directory", attached: "work", panes: []protocol.PaneInfo{withPath("%1", "")}, id: "%1", want: "Pane directory is unavailable"},
	}
	for _, tt := range refusals {
		for _, action := range []string{"status", "search"} {
			t.Run(tt.name+"/"+action, func(t *testing.T) {
				fh := newFileHarness(t)
				sink := fh.open(1)
				fh.setAttached(1, tt.attached)
				fh.tm.set(func(f *fakeTmux) {
					f.panes = tt.panes
					if tt.listErr != nil {
						f.errs["ListPanes"] = tt.listErr
					}
				})
				fh.must(1, &client.RepoRequest{Type: "repo:request", RequestID: "denied-1", ID: tt.id, Action: action, Query: ptr("config")})
				if calls := fh.repo.called(); len(calls) != 0 {
					t.Fatalf("repository service ran: %+v", calls)
				}
				got := only[*server.RepoResult](t, sink)
				e, ok := got.Result.(*protocol.RepoError)
				if !ok || got.RequestID != "denied-1" || e.Kind != "error" || e.Message != tt.want {
					t.Fatalf("repo:result = %+v %+v, want error %q", got, got.Result, tt.want)
				}
			})
		}
	}

	t.Run("correlates service errors", func(t *testing.T) {
		fh := newFileHarness(t)
		sink := fh.open(1)
		fh.setAttached(1, "work")
		fh.tm.set(func(f *fakeTmux) { f.panes = []protocol.PaneInfo{withPath("%1", "/fresh/path")} })
		fh.repo.result = &protocol.RepoError{Kind: "error", Message: "Access denied"}
		fh.must(1, &client.RepoRequest{Type: "repo:request", RequestID: "failure-1", ID: "%1", Action: "read", Path: ptr("/secret")})
		got := only[*server.RepoResult](t, sink)
		if e, ok := got.Result.(*protocol.RepoError); !ok || got.RequestID != "failure-1" || e.Message != "Access denied" {
			t.Fatalf("repo:result = %+v", got)
		}
	})
}

// TestNewWiresFiles checks what New builds for files: the guard from the
// configuration, shared by OpenFile, and a refused Start when the guard
// cannot be built.
func TestNewWiresFiles(t *testing.T) {
	root := realDir(t)
	outside := realDir(t)
	writeFile(t, filepath.Join(root, "in.txt"), "inside")
	writeFile(t, filepath.Join(outside, "out.txt"), "outside")
	if err := os.Mkdir(filepath.Join(root, "state"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "state", "token"), "secret")

	n := New(config.Config{
		Home:         root,
		AllowedPaths: []string{root},
		ConfigDir:    filepath.Join(root, "state"),
		TmuxSocket:   filepath.Join(t.TempDir(), "sock"),
	}, quiet)
	ctx := context.Background()
	f, err := n.OpenFile(ctx, filepath.Join(root, "in.txt"))
	if err != nil {
		t.Fatalf("OpenFile inside: %v", err)
	}
	f.Close()
	for _, tt := range []struct {
		path string
		want error
	}{
		{filepath.Join(outside, "out.txt"), node.ErrDenied},
		{filepath.Join(root, "state", "token"), node.ErrDenied},
		{root, node.ErrNotFile},
		{filepath.Join(root, "absent"), node.ErrNotFound},
	} {
		if _, err := n.OpenFile(ctx, tt.path); !errors.Is(err, tt.want) {
			t.Errorf("OpenFile %s = %v, want %v", tt.path, err, tt.want)
		}
	}

	// Without a home there is no deny list, so there is no file access
	// and serve must not start.
	bad := New(config.Config{AllowedPaths: []string{root}, TmuxSocket: filepath.Join(t.TempDir(), "sock")}, quiet)
	defer bad.Stop()
	if err := bad.Start(ctx); err == nil || !strings.Contains(err.Error(), "file access") {
		t.Fatalf("Start without a home = %v, want a file access error", err)
	}
	if _, err := bad.OpenFile(ctx, filepath.Join(root, "in.txt")); !errors.Is(err, ErrFilesNotWired) {
		t.Fatalf("OpenFile without files = %v", err)
	}
}
