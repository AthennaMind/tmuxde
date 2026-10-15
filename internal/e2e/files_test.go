package e2e

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/hub/ws"
	"tmuxde/internal/node/local"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/server"
)

// frame builds a client frame from a map, so paths with any bytes are
// escaped as the browser's JSON.stringify would.
func frame(t *testing.T, fields map[string]any) string {
	t.Helper()
	b, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func mustWrite(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	// WriteFile applies the umask. Chmod sets the mode as asked.
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
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

// opResult waits for the file:op:result of op on path and checks it.
// errText empty wants success.
func opResult(c *client, op, path, errText string) *server.FileOpResult {
	c.t.Helper()
	got := expect(c, waitLimit, "file:op:result "+op, func(m *server.FileOpResult) bool { return m.Op == op && m.Path == path })
	switch {
	case errText == "" && (!got.Success || got.Error != nil):
		c.t.Fatalf("%s %s failed: %q", op, path, *got.Error)
	case errText != "" && (got.Success || got.Error == nil || *got.Error != errText):
		c.t.Fatalf("%s %s = success %v, want error %q", op, path, got.Success, errText)
	}
	return got
}

// TestFiles walks the file messages through the hub and the real node on
// a seeded temp dir, the one allowed path.
func TestFiles(t *testing.T) {
	t.Parallel()
	s := newStack(t, false)
	a := s.dial("a")
	a.auth()

	seed := filepath.Join(s.home, "seed")
	mustMkdir(t, filepath.Join(seed, "zdir"))
	mustMkdir(t, filepath.Join(seed, "Adir"))
	mustWrite(t, filepath.Join(seed, "B.txt"), "bee", 0o644)
	mustWrite(t, filepath.Join(seed, "a.txt"), "a", 0o644)
	mustSymlink(t, filepath.Join(seed, "zdir"), filepath.Join(seed, "link-to-dir"))
	mustSymlink(t, filepath.Join(seed, "missing"), filepath.Join(seed, "dangling"))

	// Directories first, then names without regard to case. A link to a
	// directory is a symlink and sorts with the files. A dangling link
	// has no stat and is left out.
	a.send(frame(t, map[string]any{"type": "file:list", "path": seed}))
	list := expect(a, waitLimit, "file:list", func(m *server.FileList) bool { return m.Path == seed })
	type entry struct{ name, typ string }
	var got []entry
	for _, e := range list.Entries {
		got = append(got, entry{e.Name, e.Type})
		if e.Path != filepath.Join(seed, e.Name) {
			t.Fatalf("entry %s path %s", e.Name, e.Path)
		}
		if _, err := time.Parse(time.RFC3339Nano, e.Modified); err != nil || !strings.HasSuffix(e.Modified, "Z") {
			t.Fatalf("entry %s modified %q", e.Name, e.Modified)
		}
	}
	want := []entry{{"Adir", "directory"}, {"zdir", "directory"}, {"a.txt", "file"}, {"B.txt", "file"}, {"link-to-dir", "symlink"}}
	if !slices.Equal(got, want) {
		t.Fatalf("file:list = %v, want %v", got, want)
	}
	if e := list.Entries[3]; e.Size != 3 {
		t.Fatalf("B.txt size %v", e.Size)
	}

	// Read is cut at 100 KiB.
	big := filepath.Join(seed, "big.txt")
	mustWrite(t, big, strings.Repeat("x", 102400+10), 0o644)
	a.send(frame(t, map[string]any{"type": "file:read", "path": big}))
	content := expect(a, waitLimit, "file:content big", func(m *server.FileContent) bool { return m.Path == big })
	if !content.Truncated || len(content.Content) != 102400 {
		t.Fatalf("big read: truncated %v, %d bytes", content.Truncated, len(content.Content))
	}

	// Stat follows access(2). Root reads and writes anything, so the
	// read only case needs another user.
	ro := filepath.Join(seed, "ro.txt")
	mustWrite(t, ro, "read only", 0o444)
	a.send(frame(t, map[string]any{"type": "file:stat", "path": ro}))
	st := expect(a, waitLimit, "file:stat ro", func(m *server.FileStat) bool { return m.Stat.Path == ro }).Stat
	if st.Name != "ro.txt" || st.Type != "file" || st.Size != 9 || !st.IsReadable {
		t.Fatalf("file:stat = %+v", st)
	}
	if os.Geteuid() != 0 && (st.Permissions != "r" || st.IsWritable) {
		t.Fatalf("read only file: permissions %q, writable %v", st.Permissions, st.IsWritable)
	}
	a.send(frame(t, map[string]any{"type": "file:stat", "path": filepath.Join(seed, "a.txt")}))
	if st := expect(a, waitLimit, "file:stat a", func(m *server.FileStat) bool { return m.Stat.Name == "a.txt" }).Stat; st.Permissions != "rw" || !st.IsWritable {
		t.Fatalf("file:stat a.txt = %+v", st)
	}

	// A missing path is an unexpected failure. The hub answers with the
	// short text, without the path.
	a.send(frame(t, map[string]any{"type": "file:read", "path": filepath.Join(seed, "absent.txt")}))
	a.expectError(ws.CodeHandlerError, "No such file or directory")

	// Write, then read it back.
	target := filepath.Join(seed, "a.txt")
	a.send(frame(t, map[string]any{"type": "file:write", "path": target, "content": "written\n"}))
	wr := expect(a, waitLimit, "file:write:result", func(m *server.FileWriteResult) bool { return m.Path == target })
	if !wr.Success || wr.Size == nil || *wr.Size != 8 || wr.Error != nil {
		t.Fatalf("file:write:result = %+v", wr)
	}
	a.send(frame(t, map[string]any{"type": "file:read", "path": target}))
	if got := expect(a, waitLimit, "file:content a", func(m *server.FileContent) bool { return m.Path == target }); got.Content != "written\n" || got.Truncated {
		t.Fatalf("read after write = %+v", got)
	}

	// Create, then create again.
	created := filepath.Join(seed, "new.txt")
	a.send(frame(t, map[string]any{"type": "file:create", "path": created, "content": "fresh"}))
	opResult(a, "create", created, "")
	a.send(frame(t, map[string]any{"type": "file:create", "path": created}))
	opResult(a, "create", created, "File exists")
	if got := mustRead(t, created); got != "fresh" {
		t.Fatalf("new.txt = %q", got)
	}

	made := filepath.Join(seed, "made")
	a.send(frame(t, map[string]any{"type": "file:mkdir", "path": made}))
	opResult(a, "mkdir", made, "")
	if fi, err := os.Stat(made); err != nil || !fi.IsDir() {
		t.Fatalf("mkdir: %v", err)
	}

	// The reply names the new path.
	renamed := filepath.Join(made, "renamed.txt")
	a.send(frame(t, map[string]any{"type": "file:rename", "oldPath": created, "newPath": renamed}))
	opResult(a, "rename", renamed, "")
	if got := mustRead(t, renamed); got != "fresh" {
		t.Fatalf("renamed.txt = %q", got)
	}
	if _, err := os.Lstat(created); !os.IsNotExist(err) {
		t.Fatalf("new.txt still there: %v", err)
	}

	// Deleting a link removes the link, never its target.
	keep := filepath.Join(seed, "keep.txt")
	mustWrite(t, keep, "kept", 0o644)
	link := filepath.Join(seed, "keep-link")
	mustSymlink(t, keep, link)
	a.send(frame(t, map[string]any{"type": "file:delete", "path": link}))
	opResult(a, "delete", link, "")
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("link still there: %v", err)
	}
	if got := mustRead(t, keep); got != "kept" {
		t.Fatalf("target = %q after deleting its link", got)
	}
	a.send(frame(t, map[string]any{"type": "file:delete", "path": link}))
	opResult(a, "delete", link, "No such file or directory")

	// Denied paths never reach the file service.
	mustMkdir(t, filepath.Join(s.home, ".ssh"))
	mustWrite(t, filepath.Join(s.home, ".ssh", "id_rsa"), "KEY", 0o600)
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "secret.txt"), "SECRET", 0o600)
	for _, f := range []map[string]any{
		{"type": "file:read", "path": filepath.Join(s.home, ".ssh", "id_rsa")},
		{"type": "file:list", "path": filepath.Join(s.home, ".ssh")},
		{"type": "file:read", "path": filepath.Join(outside, "secret.txt")},
		{"type": "file:write", "path": filepath.Join(outside, "secret.txt"), "content": "x"},
		{"type": "file:delete", "path": filepath.Join(outside, "secret.txt")},
		{"type": "file:rename", "oldPath": keep, "newPath": filepath.Join(outside, "moved.txt")},
		{"type": "file:read", "path": "relative.txt"},
	} {
		a.send(frame(t, f))
		a.expectError(local.CodeAccessDenied, "Path outside allowed directories")
	}
	if got := mustRead(t, filepath.Join(outside, "secret.txt")); got != "SECRET" {
		t.Fatalf("outside file = %q", got)
	}
	if got := mustRead(t, keep); got != "kept" {
		t.Fatalf("keep.txt = %q after a denied rename", got)
	}
}

// uploadChunks splits data into n base64 chunks, as the browser sends
// them.
func uploadChunks(data []byte, n int) []string {
	size := (len(data) + n - 1) / n
	var out []string
	for i := 0; i < len(data); i += size {
		out = append(out, base64.StdEncoding.EncodeToString(data[i:min(i+size, len(data))]))
	}
	return out
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

// TestUpload sends three chunks with ack on each. The target keeps its
// old content until the final chunk renames the temp file over it.
func TestUpload(t *testing.T) {
	t.Parallel()
	s := newStack(t, false)
	a := s.dial("a")
	a.auth()
	dir := filepath.Join(s.home, "up")
	mustMkdir(t, dir)
	target := filepath.Join(dir, "photo.png")
	mustWrite(t, target, "ORIGINAL", 0o644)

	data := make([]byte, 3000)
	for i := range data {
		data[i] = byte(i * 7)
	}
	chunks := uploadChunks(data, 3)
	if len(chunks) != 3 {
		t.Fatalf("%d chunks", len(chunks))
	}
	for i, chunk := range chunks {
		final := i == len(chunks)-1
		a.send(frame(t, map[string]any{"type": "file:upload", "path": target, "content": chunk, "final": final, "ack": true}))
		got := opResult(a, "upload", target, "")
		if got.Final == nil || *got.Final != final {
			t.Fatalf("chunk %d ack final = %v", i, got.Final)
		}
		if !final {
			if got := mustRead(t, target); got != "ORIGINAL" {
				t.Fatalf("target changed after chunk %d", i)
			}
			if left := tempFiles(t, dir); len(left) != 1 {
				t.Fatalf("temp files after chunk %d: %v", i, left)
			}
		}
	}
	if got := mustRead(t, target); got != string(data) {
		t.Fatalf("uploaded %d bytes, want %d", len(got), len(data))
	}
	if left := tempFiles(t, dir); len(left) != 0 {
		t.Fatalf("temp files after the upload: %v", left)
	}

	// The file tree sends chunks without ack. Only the final one answers.
	quiet := filepath.Join(dir, "quiet.bin")
	for i, chunk := range uploadChunks([]byte("one two three"), 3) {
		a.send(frame(t, map[string]any{"type": "file:upload", "path": quiet, "content": chunk, "final": i == 2}))
	}
	if got := opResult(a, "upload", quiet, ""); got.Final != nil {
		t.Fatalf("legacy final reply has final %v", *got.Final)
	}
	n := 0
	for _, m := range a.all() {
		if r, ok := m.(*server.FileOpResult); ok && r.Path == quiet {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d replies for an upload without ack, want 1", n)
	}
	if got := mustRead(t, quiet); got != "one two three" {
		t.Fatalf("quiet.bin = %q", got)
	}
}

// TestUploadInterrupted closes the browser in the middle of an upload.
// The original file stays and the temp file goes.
func TestUploadInterrupted(t *testing.T) {
	t.Parallel()
	s := newStack(t, false)
	a := s.dial("a")
	a.auth()
	target := filepath.Join(s.home, "keep.txt")
	mustWrite(t, target, "ORIGINAL", 0o644)
	for _, chunk := range uploadChunks([]byte("partial upload"), 3)[:2] {
		a.send(frame(t, map[string]any{"type": "file:upload", "path": target, "content": chunk, "final": false, "ack": true}))
		opResult(a, "upload", target, "")
	}
	if left := tempFiles(t, s.home); len(left) != 1 {
		t.Fatalf("temp files mid upload: %v", left)
	}
	if err := a.conn.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Logf("close handshake: %v", err)
	}
	_ = a.closed()
	s.tmux.waitTmux("open node connections", "0", func() string {
		if s.node.OpenCount() == 0 {
			return "0"
		}
		return "more"
	})
	if left := tempFiles(t, s.home); len(left) != 0 {
		t.Fatalf("temp files after close: %v", left)
	}
	if got := mustRead(t, target); got != "ORIGINAL" {
		t.Fatalf("target = %q after an interrupted upload", got)
	}
}

// TestWatch watches a directory, sees a new file, then unwatches it.
func TestWatch(t *testing.T) {
	t.Parallel()
	s := newStack(t, false)
	a := s.dial("a")
	a.auth()
	dir := filepath.Join(s.home, "watched")
	other := filepath.Join(s.home, "other")
	mustMkdir(t, dir)
	mustMkdir(t, other)

	// One connection's messages run in order, so the stat reply shows the
	// watch before it has run. A watch sends nothing on success.
	barrier := func() {
		t.Helper()
		a.send(frame(t, map[string]any{"type": "file:stat", "path": s.home}))
		expect(a, waitLimit, "file:stat sync", func(m *server.FileStat) bool { return m.Stat.Path == s.home })
	}
	a.send(frame(t, map[string]any{"type": "file:watch", "path": dir}))
	barrier()

	added := filepath.Join(dir, "new.txt")
	mustWrite(t, added, "x", 0o644)
	expect(a, waitLimit, "file:changed add", func(m *server.FileChanged) bool { return m.Path == added && m.Event == "add" })

	// After unwatch nothing more comes from dir. The second watcher bounds
	// the wait: its event follows the file made in dir.
	a.send(frame(t, map[string]any{"type": "file:unwatch", "path": dir}))
	a.send(frame(t, map[string]any{"type": "file:watch", "path": other}))
	barrier()
	a.skip()
	late := filepath.Join(dir, "late.txt")
	mustWrite(t, late, "x", 0o644)
	marker := filepath.Join(other, "marker.txt")
	mustWrite(t, marker, "x", 0o644)
	expect(a, waitLimit, "file:changed marker", func(m *server.FileChanged) bool { return m.Path == marker && m.Event == "add" })
	for _, m := range a.all() {
		if c, ok := m.(*server.FileChanged); ok && filepath.Dir(c.Path) == dir && c.Path != added {
			t.Fatalf("event after unwatch: %+v", c)
		}
	}

	// Watching a file is a synchronous failure.
	a.send(frame(t, map[string]any{"type": "file:watch", "path": marker}))
	a.expectError(local.CodeWatchFailed, "Not a directory")
}

// git runs git in dir for a test repository, with a fixed identity and
// no user or system configuration.
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	base := []string{"-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-C", dir}
	cmd := exec.Command("git", append(base, args...)...)
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GIT_") {
			env = append(env, kv)
		}
	}
	cmd.Env = append(env, "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return string(out)
}

// repoResult sends one repo:request and returns its result.
func repoResult[T protocol.RepoResult](t *testing.T, c *client, fields map[string]any) T {
	t.Helper()
	fields["type"] = "repo:request"
	id := fields["requestId"].(string)
	c.send(frame(t, fields))
	got := expect(c, waitLimit, "repo:result "+id, func(m *server.RepoResult) bool { return m.RequestID == id })
	r, ok := got.Result.(T)
	if !ok {
		t.Fatalf("repo:result %s = %+v", id, got.Result)
	}
	return r
}

// TestRepository asks the repository viewer about a temp Git repository
// that the attached pane sits in.
func TestRepository(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not found: %v", err)
	}
	s := newStack(t, false)
	root := filepath.Join(s.home, "repo")
	mustMkdir(t, root)
	git(t, root, "init", "-q")
	mustWrite(t, filepath.Join(root, "a.txt"), "one\n", 0o644)
	git(t, root, "add", "a.txt")
	git(t, root, "commit", "-q", "-m", "first commit")
	hash := strings.TrimSpace(git(t, root, "rev-parse", "HEAD"))
	mustWrite(t, filepath.Join(root, "a.txt"), "one\ntwo\n", 0o644)
	mustWrite(t, filepath.Join(root, "new.txt"), "untracked\n", 0o644)

	a := s.dial("a")
	a.auth()
	a.send(frame(t, map[string]any{"type": "session:create", "name": "repo", "cwd": root}))
	expect(a, waitLimit, "session:created repo", func(m *server.SessionCreated) bool { return m.Session.Name == "repo" })
	a.send(`{"type":"session:attach","name":"repo"}`)
	expect(a, waitLimit, "session:attached repo", func(m *server.SessionAttached) bool { return m.Name == "repo" })
	a.send(`{"type":"pane:list"}`)
	pl := expect(a, waitLimit, "pane:list", func(*server.PaneList) bool { return true })
	if len(pl.Panes) != 1 {
		t.Fatalf("pane:list = %+v", pl)
	}
	paneID := pl.Panes[0].ID

	// The browser's path is ignored. The pane directory comes from tmux.
	ctxResult := repoResult[*protocol.RepoContext](t, a, map[string]any{"requestId": "ctx", "id": paneID, "action": "context", "path": "/stale"})
	if ctxResult.Path != root || ctxResult.Root == nil || *ctxResult.Root != root || ctxResult.Branch == nil || *ctxResult.Branch != "main" {
		t.Fatalf("context = %+v", ctxResult)
	}

	status := repoResult[*protocol.RepoStatus](t, a, map[string]any{"requestId": "status", "id": paneID, "action": "status"})
	type change struct{ path, index, worktree string }
	var changes []change
	for _, e := range status.Entries {
		changes = append(changes, change{e.Path, e.Index, e.Worktree})
	}
	if want := []change{{"a.txt", " ", "M"}, {"new.txt", "?", "?"}}; !slices.Equal(changes, want) || status.Truncated {
		t.Fatalf("status = %v, want %v", changes, want)
	}

	diff := repoResult[*protocol.RepoDiff](t, a, map[string]any{"requestId": "diff", "id": paneID, "action": "diff", "file": "a.txt", "scope": "unstaged"})
	if diff.Path != "a.txt" || diff.Scope != "unstaged" || !strings.Contains(diff.Content, "\n+two\n") || diff.Binary || diff.Truncated {
		t.Fatalf("diff = %+v", diff)
	}
	untracked := repoResult[*protocol.RepoDiff](t, a, map[string]any{"requestId": "untracked", "id": paneID, "action": "diff", "file": "new.txt", "scope": "untracked"})
	if !strings.Contains(untracked.Content, "+untracked\n") {
		t.Fatalf("untracked diff = %+v", untracked)
	}

	history := repoResult[*protocol.RepoLog](t, a, map[string]any{"requestId": "log", "id": paneID, "action": "log"})
	if len(history.Commits) != 1 || history.More || history.Commits[0].Hash != hash || history.Commits[0].Subject != "first commit" || history.Commits[0].Author != "Test" {
		t.Fatalf("log = %+v", history)
	}
	if !slices.Contains(history.Commits[0].Refs, "HEAD -> main") {
		t.Fatalf("refs = %v", history.Commits[0].Refs)
	}

	show := repoResult[*protocol.RepoShow](t, a, map[string]any{"requestId": "show", "id": paneID, "action": "show", "commit": hash})
	if show.Root != root || show.Commit.Hash != hash || show.Commit.Subject != "first commit" || show.Commit.Email != "test@example.invalid" || len(show.Files) != 1 {
		t.Fatalf("show = %+v", show)
	}
	if f := show.Files[0]; f.Path != "a.txt" || f.Status != "A" || f.Additions == nil || *f.Additions != 1 || !strings.Contains(f.Patch, "+one") {
		t.Fatalf("show file = %+v", f)
	}

	// Errors of the service come back as kind error with the request id.
	bad := repoResult[*protocol.RepoError](t, a, map[string]any{"requestId": "bad", "id": paneID, "action": "show", "commit": strings.Repeat("0", 40)})
	if bad.Message != "Commit not found" {
		t.Fatalf("unknown commit = %+v", bad)
	}

	// A pane of another session is refused, as kind error, never as a
	// plain error message.
	s.tmux.must("new-session", "-d", "-s", "other", "-c", root, "/bin/sh")
	otherPane := strings.TrimSpace(s.tmux.must("list-panes", "-t", "=other:", "-F", "#{pane_id}"))
	foreign := repoResult[*protocol.RepoError](t, a, map[string]any{"requestId": "foreign", "id": otherPane, "action": "status"})
	if foreign.Message != `Pane "`+otherPane+`" not found` {
		t.Fatalf("foreign pane = %+v", foreign)
	}
	for _, m := range a.all() {
		if e, ok := m.(*server.Error); ok {
			t.Fatalf("repository answered a plain error: %+v", e)
		}
	}

	// Detached, nothing is in scope.
	a.send(`{"type":"session:detach"}`)
	detached := repoResult[*protocol.RepoError](t, a, map[string]any{"requestId": "detached", "id": paneID, "action": "context"})
	if detached.Message != "No session attached" {
		t.Fatalf("detached = %+v", detached)
	}
}

// TestFileDownload fetches files through GET /file on the same server
// as the WebSocket.
func TestFileDownload(t *testing.T) {
	t.Parallel()
	s := newStack(t, false)
	data := []byte("\x89PNG\r\n\x1a\n0123456789")
	img := filepath.Join(s.home, "pic.png")
	mustWrite(t, img, string(data), 0o644)
	mustMkdir(t, filepath.Join(s.home, ".ssh"))
	mustWrite(t, filepath.Join(s.home, ".ssh", "id_rsa"), "KEY", 0o600)
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "x.png"), "OUT", 0o644)

	httpClient := &http.Client{Transport: &http.Transport{}, Timeout: waitLimit}
	t.Cleanup(httpClient.CloseIdleConnections)
	get := func(path, auth, rng string) (int, http.Header, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, s.base+"/file?path="+url.QueryEscape(path), nil)
		if err != nil {
			t.Fatal(err)
		}
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		if rng != "" {
			req.Header.Set("Range", rng)
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, resp.Header, string(body)
	}

	code, hdr, body := get(img, token, "")
	if code != http.StatusOK || body != string(data) || hdr.Get("Content-Type") != "image/png" || hdr.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("GET = %d %q %v", code, body, hdr)
	}
	code, hdr, body = get(img, token, "bytes=2-5")
	if code != http.StatusPartialContent || body != string(data[2:6]) || hdr.Get("Content-Range") != "bytes 2-5/18" {
		t.Fatalf("range = %d %q %q", code, body, hdr.Get("Content-Range"))
	}
	for _, tt := range []struct {
		name, path, auth string
		code             int
		body             string
	}{
		{"bad token", img, "wrong-token-0123456789", http.StatusUnauthorized, "Unauthorized"},
		{"no token", img, "", http.StatusUnauthorized, "Unauthorized"},
		{"credential dir", filepath.Join(s.home, ".ssh", "id_rsa"), token, http.StatusForbidden, "Access denied"},
		{"outside", filepath.Join(outside, "x.png"), token, http.StatusForbidden, "Access denied"},
		{"directory", s.home, token, http.StatusNotFound, "Not a file"},
		{"missing", filepath.Join(s.home, "absent.png"), token, http.StatusNotFound, "File not found"},
	} {
		if code, _, body := get(tt.path, tt.auth, ""); code != tt.code || body != tt.body {
			t.Errorf("%s: GET = %d %q, want %d %q", tt.name, code, body, tt.code, tt.body)
		}
	}
}
