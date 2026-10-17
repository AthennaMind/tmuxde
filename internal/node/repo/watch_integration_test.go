//go:build integration

package repo

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"tmuxde/internal/protocol/server"
)

// watchHarness is a repository in a temp dir with a running watch.
type watchHarness struct {
	t    *testing.T
	base string
	root string
	git  *gitRunner
	s    *Service
	out  chan *server.RepoChanged
	// results gets the repo:watch:result a watch sends after its start.
	results chan *server.RepoWatchResult
}

// fastWatch keeps tests short. The burst test sets its own.
var fastWatch = WatchOptions{Debounce: 60 * time.Millisecond, MaxWait: 400 * time.Millisecond}

func newWatchHarness(t *testing.T, opts WatchOptions, denied ...string) *watchHarness {
	t.Helper()
	base := tempBase(t)
	root := filepath.Join(base, "repo")
	mustMkdir(t, root)
	g := newGit(t, filepath.Join(base, "home"))
	g.init(root, "-b", "main")
	mustWrite(t, filepath.Join(root, "README.md"), "hello\n")
	g.run(root, "add", "README.md")
	g.run(root, "commit", "-q", "-m", "init")
	var deny []string
	for _, d := range denied {
		mustMkdir(t, filepath.Join(root, d))
		deny = append(deny, filepath.Join(root, d))
	}
	guard := newTestGuard(t, []string{base}, deny)
	return &watchHarness{
		t:       t,
		base:    base,
		root:    root,
		git:     g,
		s:       newService(guard, Options{Watch: opts}),
		out:     make(chan *server.RepoChanged, 64),
		results: make(chan *server.RepoWatchResult, 8),
	}
}

// send is the send function of a watch. It sorts messages by type.
func (h *watchHarness) send(m server.Message) {
	switch m := m.(type) {
	case *server.RepoChanged:
		h.out <- m
	case *server.RepoWatchResult:
		h.results <- m
	default:
		h.t.Errorf("watch sent %s", m.WireType())
	}
}

// logGit puts a Git wrapper first on PATH that logs each call and runs
// the real Git. The function it returns lists the Git commands called so
// far, without the repository flags and config every call has.
func (h *watchHarness) logGit() func() []string {
	h.t.Helper()
	calls := filepath.Join(h.base, "calls")
	fakeGit(h.t, h.base, "#!/bin/sh\n"+
		"{ for a in \"$@\"; do printf '%s\\037' \"$a\"; done; printf '\\036'; } >> "+calls+"\n"+
		"exec "+h.git.bin+" \"$@\"\n")
	return func() []string {
		data, err := os.ReadFile(calls)
		if err != nil && !os.IsNotExist(err) {
			h.t.Fatal(err)
		}
		var got []string
		for call := range strings.SplitSeq(string(data), "\x1e") {
			fields := strings.Split(call, "\x1f")
			if n := 5 + len(gitConfig); len(fields) > n {
				got = append(got, fields[n])
			}
		}
		return got
	}
}

// count is how often command shows up in calls.
func count(calls []string, command string) int {
	n := 0
	for _, c := range calls {
		if c == command {
			n++
		}
	}
	return n
}

// eventually polls ok on the watcher goroutine until it holds.
func eventually(t *testing.T, w *Watcher, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		got := make(chan bool, 1)
		w.calls <- func() { got <- ok() }
		if <-got {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting: %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// watching reports whether the watcher holds dir, asked on its goroutine.
func watching(t *testing.T, w *Watcher, dir string) bool {
	t.Helper()
	got := make(chan bool, 1)
	select {
	case w.calls <- func() { got <- w.dirs[dir] }:
	case <-time.After(5 * time.Second):
		t.Fatal("watcher goroutine is not running")
	}
	return <-got
}

// watchCount is the number of work tree directories, asked on the
// watcher goroutine.
func watchCount(t *testing.T, w *Watcher) int {
	t.Helper()
	got := make(chan int, 1)
	w.calls <- func() { got <- len(w.dirs) }
	return <-got
}

func (h *watchHarness) path(parts ...string) string {
	return filepath.Join(append([]string{h.root}, parts...)...)
}

// start watches the repository and closes the watch at cleanup.
func (h *watchHarness) start(ctx context.Context) *Watcher {
	h.t.Helper()
	root, err := h.s.WatchRoot(ctx, h.root, nil)
	if err != nil {
		h.t.Fatalf("WatchRoot: %v", err)
	}
	if root != h.root {
		h.t.Fatalf("root = %q, want %q", root, h.root)
	}
	handle, err := h.s.Watch(ctx, root, h.send)
	if err != nil {
		h.t.Fatalf("Watch: %v", err)
	}
	h.t.Cleanup(func() { _ = handle.Close() })
	return handle.(*Watcher)
}

// next waits for one message, checks that it encodes and returns it.
func (h *watchHarness) next() *server.RepoChanged {
	h.t.Helper()
	select {
	case m := <-h.out:
		if _, err := server.Encode(m); err != nil {
			h.t.Fatalf("encode %+v: %v", m, err)
		}
		return m
	case <-time.After(5 * time.Second):
		h.t.Fatal("no repo:changed")
	}
	return nil
}

// none checks that nothing arrives for d.
func (h *watchHarness) none(d time.Duration) {
	h.t.Helper()
	select {
	case m := <-h.out:
		h.t.Fatalf("unexpected repo:changed %+v", m)
	case <-time.After(d):
	}
}

// until reads messages until one passes ok.
func (h *watchHarness) until(ok func(*server.RepoChanged) bool) *server.RepoChanged {
	h.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m := <-h.out:
			if ok(m) {
				return m
			}
		case <-deadline:
			h.t.Fatal("no matching repo:changed")
			return nil
		}
	}
}

func TestIntegrationWatchFileChange(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	w := h.start(t.Context())
	if w.Partial() {
		t.Fatal("small repository is partial")
	}
	// Starting sends nothing.
	h.none(200 * time.Millisecond)

	mustWrite(t, h.path("new.txt"), "x")
	got := h.next()
	if got.Root != h.root || got.Git || got.Truncated || !slices.Equal(got.Paths, []string{"new.txt"}) {
		t.Fatalf("repo:changed = %+v", got)
	}
	h.none(200 * time.Millisecond)

	// An editor swap file is not a change.
	mustWrite(t, h.path(".new.txt.swp"), "x")
	h.none(200 * time.Millisecond)
}

func TestIntegrationWatchGitChanges(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	h.start(t.Context())
	mustWrite(t, h.path("README.md"), "changed\n")
	if got := h.next(); got.Git || got.Refs || !slices.Equal(got.Paths, []string{"README.md"}) {
		t.Fatalf("write = %+v", got)
	}

	// The index alone is a Git change, not a ref change.
	h.git.run(h.root, "add", "README.md")
	if got := h.next(); !got.Git || got.Refs || len(got.Paths) != 0 {
		t.Fatalf("add = %+v", got)
	}
	refs := func(m *server.RepoChanged) bool { return m.Git && m.Refs }
	h.git.run(h.root, "commit", "-q", "-m", "second")
	h.until(refs)

	// So is the index refresh of git status after a touch. Let the commit
	// settle first.
	for quiet := false; !quiet; {
		select {
		case <-h.out:
		case <-time.After(300 * time.Millisecond):
			quiet = true
		}
	}
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(h.path("README.md"), past, past); err != nil {
		t.Fatal(err)
	}
	h.git.run(h.root, "status", "--porcelain")
	got := h.until(func(m *server.RepoChanged) bool { return m.Git })
	if got.Refs {
		t.Fatalf("status = %+v", got)
	}

	// A new branch adds a ref, a checkout moves HEAD.
	h.git.run(h.root, "branch", "topic/one")
	h.until(refs)
	h.git.run(h.root, "checkout", "-q", "topic/one")
	h.until(refs)
}

func TestIntegrationWatchIgnored(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	mustWrite(t, h.path(".gitignore"), "build/\nnode_modules/\n*.log\n")
	mustMkdir(t, h.path("build", "deep"))
	h.git.run(h.root, "add", ".gitignore")
	h.git.run(h.root, "commit", "-q", "-m", "ignore")
	w := h.start(t.Context())
	if watching(t, w, h.path("build")) || watching(t, w, h.path("build", "deep")) {
		t.Fatal("ignored directory is watched")
	}

	mustWrite(t, h.path("build", "out.txt"), "x")
	mustWrite(t, h.path("build", "deep", "out.txt"), "x")
	h.none(250 * time.Millisecond)

	// An ignored directory made after the start is not watched either.
	mustMkdir(t, h.path("node_modules", "pkg"))
	h.none(250 * time.Millisecond)
	mustWrite(t, h.path("node_modules", "pkg", "index.js"), "x")
	h.none(250 * time.Millisecond)
	if watching(t, w, h.path("node_modules")) {
		t.Fatal("new ignored directory is watched")
	}
}

func TestIntegrationWatchNewIgnoredFile(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	mustWrite(t, h.path(".gitignore"), "*.log\n")
	mustWrite(t, h.path("kept.log"), "tracked\n")
	h.git.run(h.root, "add", ".gitignore")
	h.git.run(h.root, "add", "-f", "kept.log")
	h.git.run(h.root, "commit", "-q", "-m", "ignore")
	calls := h.logGit()
	w := h.start(t.Context())
	before := len(calls())

	// A log file made after the start sends nothing, and Git judges it
	// once. The writes are batches of their own.
	for i := range 5 {
		mustWrite(t, h.path("app.log"), fmt.Sprint(i))
		h.none(150 * time.Millisecond)
	}
	if n := count(calls()[before:], "check-ignore"); n != 1 {
		t.Fatalf("check-ignore ran %d times, want 1", n)
	}
	eventually(t, w, "app.log is known as ignored", func() bool { return w.known["app.log"] })

	// In a batch with a file that is not ignored, only that one goes out.
	mustWrite(t, h.path("new.log"), "x")
	mustWrite(t, h.path("new.txt"), "x")
	if got := h.next(); got.Truncated || got.Git || !slices.Equal(got.Paths, []string{"new.txt"}) {
		t.Fatalf("mixed batch = %+v", got)
	}
	// A tracked file is never ignored.
	mustWrite(t, h.path("kept.log"), "changed\n")
	if got := h.next(); !slices.Equal(got.Paths, []string{"kept.log"}) {
		t.Fatalf("tracked log = %+v", got)
	}
	h.none(150 * time.Millisecond)
}

func TestIntegrationWatchFolderOfIgnoredFiles(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	mustWrite(t, h.path(".gitignore"), "*.log\nbuild/\n")
	mustMkdir(t, h.path("build"))
	mustMkdir(t, h.path("logs"))
	mustWrite(t, h.path("logs", "a.log"), "x")
	h.git.run(h.root, "add", ".gitignore")
	h.git.run(h.root, "commit", "-q", "-m", "ignore")
	w := h.start(t.Context())
	// ls-files names logs/ since it only holds ignored files, but no rule
	// matches the folder itself.
	if !watching(t, w, h.path("logs")) || watching(t, w, h.path("build")) {
		t.Fatal("logs must be watched and build not")
	}
	mustWrite(t, h.path("logs", "b.log"), "x")
	h.none(200 * time.Millisecond)
	mustWrite(t, h.path("logs", "notes.md"), "x")
	if got := h.next(); !slices.Equal(got.Paths, []string{"logs/notes.md"}) {
		t.Fatalf("new file in logs = %+v", got)
	}

	// The same for a folder made with a log file in it.
	mustMkdir(t, h.path("data"))
	mustWrite(t, h.path("data", "x.log"), "x")
	eventually(t, w, "data is watched", func() bool { return w.dirs[h.path("data")] })
	h.until(func(m *server.RepoChanged) bool { return slices.Contains(m.Paths, "data") })
	mustWrite(t, h.path("data", "readme.txt"), "x")
	h.until(func(m *server.RepoChanged) bool { return slices.Contains(m.Paths, "data/readme.txt") })
}

func TestIntegrationWatchIgnoreRulesChange(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	mustWrite(t, h.path(".gitignore"), "build/\n")
	mustMkdir(t, h.path("build", "deep"))
	mustMkdir(t, h.path("tmp"))
	h.git.run(h.root, "add", ".gitignore")
	h.git.run(h.root, "commit", "-q", "-m", "ignore")
	// info shows up after the start below.
	if err := os.RemoveAll(h.path(".git", "info")); err != nil {
		t.Fatal(err)
	}
	w := h.start(t.Context())
	if watching(t, w, h.path("build")) {
		t.Fatal("ignored directory is watched")
	}

	// build is no longer ignored. Its folders get watched, and the batch
	// is truncated, since they may hold changes no event reported.
	mustWrite(t, h.path(".gitignore"), "*.log\n")
	if got := h.next(); !got.Truncated || !slices.Contains(got.Paths, ".gitignore") {
		t.Fatalf(".gitignore edit = %+v", got)
	}
	if !watching(t, w, h.path("build")) || !watching(t, w, h.path("build", "deep")) {
		t.Fatal("folders no longer ignored are not watched")
	}
	mustWrite(t, h.path("build", "deep", "new.txt"), "x")
	if got := h.next(); got.Truncated || !slices.Equal(got.Paths, []string{"build/deep/new.txt"}) {
		t.Fatalf("write in build = %+v", got)
	}
	// The log file ignored now sends nothing.
	mustWrite(t, h.path("app.log"), "x")
	h.none(200 * time.Millisecond)

	// build is ignored again, and its folders drop out.
	mustWrite(t, h.path(".gitignore"), "build/\n")
	if got := h.next(); !got.Truncated {
		t.Fatalf(".gitignore edit = %+v", got)
	}
	if watching(t, w, h.path("build")) || watching(t, w, h.path("build", "deep")) {
		t.Fatal("ignored folders are still watched")
	}
	mustWrite(t, h.path("build", "x.txt"), "x")
	h.none(200 * time.Millisecond)

	// info/exclude counts as well, also when info is made after the start.
	mustMkdir(t, h.path(".git", "info"))
	mustWrite(t, h.path(".git", "info", "exclude"), "tmp/\n")
	h.until(func(m *server.RepoChanged) bool { return m.Truncated })
	eventually(t, w, "tmp drops out", func() bool { return !w.dirs[h.path("tmp")] })
	// The two writes may have gone out in two batches.
	time.Sleep(200 * time.Millisecond)
	for len(h.out) > 0 {
		<-h.out
	}
	mustWrite(t, h.path("tmp", "a.txt"), "x")
	h.none(200 * time.Millisecond)
}

func TestIntegrationWatchManyNewDirectories(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	calls := h.logGit()
	w := h.start(t.Context())
	mustMkdir(t, h.path("burst"))
	if got := h.next(); !slices.Equal(got.Paths, []string{"burst"}) {
		t.Fatalf("mkdir = %+v", got)
	}
	before := len(calls())
	const n = 300
	for i := range n {
		mustMkdir(t, h.path("burst", fmt.Sprintf("d%03d", i)))
	}
	eventually(t, w, "every new folder is watched", func() bool { return len(w.dirs) == n+2 })
	h.until(func(m *server.RepoChanged) bool { return m.Truncated })
	// Each drain of events asks Git once for all of its folders, not once
	// per folder.
	if got := count(calls()[before:], "ls-files"); got == 0 || got > n/10 {
		t.Fatalf("ls-files ran %d times for %d folders", got, n)
	}
	t.Logf("ls-files ran %d times for %d folders", count(calls()[before:], "ls-files"), n)
	if w.Partial() {
		t.Fatal("watch is partial")
	}
	mustWrite(t, h.path("burst", "d299", "x.txt"), "x")
	h.until(func(m *server.RepoChanged) bool { return slices.Contains(m.Paths, "burst/d299/x.txt") })
}

func TestIntegrationWatchCapAfterStart(t *testing.T) {
	h := newWatchHarness(t, WatchOptions{MaxDirs: 3, Debounce: fastWatch.Debounce, MaxWait: fastWatch.MaxWait})
	w := h.start(t.Context())
	if w.Partial() {
		t.Fatal("watch of the root only is partial")
	}
	for _, d := range []string{"a", "b", "c", "d"} {
		mustMkdir(t, h.path(d))
	}
	// The client learns that part of the tree is not watched.
	select {
	case got := <-h.results:
		if !got.OK || !got.Partial || got.Root == nil || *got.Root != h.root {
			t.Fatalf("repo:watch:result = %+v", got)
		}
		if _, err := server.Encode(got); err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no repo:watch:result after the cap")
	}
	if !w.Partial() {
		t.Fatal("Partial is false after the cap")
	}
	if n := watchCount(t, w); n != 3 {
		t.Fatalf("watched %d directories, want 3", n)
	}
	// It says so once.
	mustMkdir(t, h.path("e"))
	h.until(func(m *server.RepoChanged) bool { return slices.Contains(m.Paths, "e") })
	select {
	case got := <-h.results:
		t.Fatalf("second repo:watch:result %+v", got)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestIntegrationWatchNewDirectory(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	w := h.start(t.Context())
	mustMkdir(t, h.path("src", "lib"))
	if got := h.next(); !slices.Equal(got.Paths, []string{"src"}) {
		t.Fatalf("mkdir = %+v", got)
	}
	mustWrite(t, h.path("src", "lib", "a.go"), "package lib\n")
	if got := h.next(); !slices.Equal(got.Paths, []string{"src/lib/a.go"}) {
		t.Fatalf("write = %+v", got)
	}

	// A moved directory is watched under its new name only.
	if err := os.Rename(h.path("src"), h.path("pkg")); err != nil {
		t.Fatal(err)
	}
	if got := h.next(); !slices.Equal(got.Paths, []string{"pkg", "src"}) {
		t.Fatalf("rename = %+v", got)
	}
	mustWrite(t, h.path("pkg", "lib", "b.go"), "package lib\n")
	if got := h.next(); !slices.Equal(got.Paths, []string{"pkg/lib/b.go"}) {
		t.Fatalf("write after rename = %+v", got)
	}
	if watching(t, w, h.path("src")) || watching(t, w, h.path("src", "lib")) || !watching(t, w, h.path("pkg", "lib")) {
		t.Fatal("old names still watched")
	}
}

func TestIntegrationWatchSkipsLinksAndDenied(t *testing.T) {
	h := newWatchHarness(t, fastWatch, "secret")
	outside := filepath.Join(h.base, "outside")
	mustMkdir(t, outside)
	mustSymlink(t, outside, h.path("link"))
	w := h.start(t.Context())
	if watching(t, w, h.path("link")) || watching(t, w, h.path("secret")) {
		t.Fatal("watched a symlink or a denied directory")
	}
	mustWrite(t, filepath.Join(outside, "a.txt"), "x")
	mustWrite(t, h.path("secret", "key"), "x")
	h.none(250 * time.Millisecond)
}

func TestIntegrationWatchCap(t *testing.T) {
	h := newWatchHarness(t, WatchOptions{MaxDirs: 2, Debounce: fastWatch.Debounce, MaxWait: fastWatch.MaxWait})
	mustMkdir(t, h.path("a"))
	mustMkdir(t, h.path("b"))
	mustMkdir(t, h.path("c"))
	w := h.start(t.Context())
	if !w.Partial() {
		t.Fatal("watch past the cap is not partial")
	}
	if n := watchCount(t, w); n != 2 {
		t.Fatalf("watched %d directories, want 2", n)
	}
	// The root is still watched.
	mustWrite(t, h.path("top.txt"), "x")
	h.until(func(m *server.RepoChanged) bool { return slices.Contains(m.Paths, "top.txt") })
}

func TestIntegrationWatchNotRepository(t *testing.T) {
	base := tempBase(t)
	plain := filepath.Join(base, "plain")
	mustMkdir(t, plain)
	s := newService(newTestGuard(t, []string{base}, nil), Options{})
	_, err := s.WatchRoot(t.Context(), plain, nil)
	if err == nil || Message(err) != msgNotRepository {
		t.Fatalf("WatchRoot = %v", err)
	}
	// A relative or empty context path is refused.
	for _, p := range []string{"", "plain"} {
		if _, err := s.WatchRoot(t.Context(), plain, &p); err == nil || Message(err) != msgDenied {
			t.Fatalf("WatchRoot(%q) = %v", p, err)
		}
	}
	if _, err := s.Watch(t.Context(), plain, nil); err == nil {
		t.Fatal("Watch of a plain folder started")
	}
}

func TestIntegrationWatchContextPath(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	other := filepath.Join(h.base, "elsewhere")
	mustMkdir(t, other)
	sub := h.path("sub")
	mustMkdir(t, sub)
	// The captured context wins over the pane folder.
	root, err := h.s.WatchRoot(t.Context(), other, &sub)
	if err != nil || root != h.root {
		t.Fatalf("WatchRoot = %q, %v", root, err)
	}
}

func TestIntegrationWatchCloseStopsEvents(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	w := h.start(t.Context())
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	mustWrite(t, h.path("late.txt"), "x")
	h.none(250 * time.Millisecond)
}

func TestIntegrationWatchContextEnds(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	ctx, cancel := context.WithCancel(t.Context())
	w := h.start(ctx)
	cancel()
	select {
	case <-w.done:
	case <-time.After(2 * time.Second):
		t.Fatal("watcher runs after its context ended")
	}
}

func TestIntegrationWatchBurst(t *testing.T) {
	h := newWatchHarness(t, WatchOptions{Debounce: 150 * time.Millisecond, MaxWait: 3 * time.Second})
	h.start(t.Context())
	for i := range 200 {
		mustWrite(t, h.path(fmt.Sprintf("f%03d.txt", i)), "x")
	}
	got := h.next()
	if !got.Truncated || len(got.Paths) != server.RepoChangedMaxPaths || !slices.IsSorted(got.Paths) {
		t.Fatalf("burst = %d paths, truncated %v", len(got.Paths), got.Truncated)
	}
	h.none(400 * time.Millisecond)
}

func TestIntegrationWatchMaxWait(t *testing.T) {
	h := newWatchHarness(t, WatchOptions{Debounce: 200 * time.Millisecond, MaxWait: 300 * time.Millisecond})
	h.start(t.Context())
	// Writes every 50 ms never leave the debounce quiet time, so only the
	// maximum wait sends.
	start := time.Now()
	stop := time.After(900 * time.Millisecond)
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	i := 0
loop:
	for {
		select {
		case <-tick.C:
			i++
			mustWrite(t, h.path("stream.txt"), fmt.Sprint(i))
		case <-stop:
			break loop
		}
	}
	h.next()
	if d := time.Since(start); d > 900*time.Millisecond+time.Second {
		t.Fatalf("first message after %v", d)
	}
	select {
	case <-h.out:
	default:
		t.Fatal("a steady stream sent only one message")
	}
}

func TestIntegrationWatchLinkedWorktree(t *testing.T) {
	h := newWatchHarness(t, fastWatch)
	wt := filepath.Join(h.base, "wt")
	h.git.run(h.root, "worktree", "add", "-q", "-b", "side", wt)
	root, err := h.s.WatchRoot(t.Context(), wt, nil)
	if err != nil || root != wt {
		t.Fatalf("WatchRoot = %q, %v", root, err)
	}
	handle, err := h.s.Watch(t.Context(), root, h.send)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	w := handle.(*Watcher)
	if len(w.gitDirs) != 2 {
		t.Fatalf("git dirs = %v, want the worktree and the common dir", w.gitDirs)
	}
	mustWrite(t, filepath.Join(wt, "side.txt"), "x")
	h.until(func(m *server.RepoChanged) bool { return slices.Contains(m.Paths, "side.txt") })
	h.git.run(wt, "add", "side.txt")
	h.until(func(m *server.RepoChanged) bool { return m.Git && !m.Refs })
	h.git.run(wt, "commit", "-q", "-m", "side")
	h.until(func(m *server.RepoChanged) bool { return m.Git && m.Refs })
	// A branch made from the main work tree lands in the common refs.
	h.git.run(h.root, "branch", "other")
	h.until(func(m *server.RepoChanged) bool { return m.Git && m.Refs })
}
