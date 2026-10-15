package files

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"

	"tmuxde/internal/node"
)

type fsEvent struct{ path, event string }

// waitFor is the deadline for an event that must come.
const waitFor = 5 * time.Second

// settle is how long a check for no further events waits. It covers the
// atomic delay and a throttle window with room to spare.
const settle = 400 * time.Millisecond

// startWatch watches dir and returns the event channel. The watcher is
// closed when the test ends.
func startWatch(t *testing.T, svc *Service, dir string) (*Watcher, <-chan fsEvent) {
	t.Helper()
	ch := make(chan fsEvent, 256)
	w, err := svc.Watch(context.Background(), dir, func(path, event string) {
		ch <- fsEvent{path, event}
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Close() })
	return w, ch
}

func expectEvents(t *testing.T, ch <-chan fsEvent, want ...fsEvent) {
	t.Helper()
	deadline := time.After(waitFor)
	for _, w := range want {
		select {
		case got := <-ch:
			if got != w {
				t.Fatalf("event %+v, want %+v", got, w)
			}
		case <-deadline:
			t.Fatalf("no event %+v within %v", w, waitFor)
		}
	}
}

func expectQuiet(t *testing.T, ch <-chan fsEvent) {
	t.Helper()
	select {
	case got := <-ch:
		t.Fatalf("unexpected event %+v", got)
	case <-time.After(settle):
	}
}

// expectAtMostOne allows one more event equal to want, then nothing.
func expectAtMostOne(t *testing.T, ch <-chan fsEvent, want fsEvent) {
	t.Helper()
	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("unexpected event %+v", got)
		}
		expectQuiet(t, ch)
	case <-time.After(settle):
	}
}

func TestWatchEvents(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.user, "watched")
	mkdir(t, filepath.Join(dir, "old-dir"))
	writeFile(t, filepath.Join(dir, "old.txt"), "old")
	_, ch := startWatch(t, f.svc, dir)

	t.Run("add", func(t *testing.T) {
		p := filepath.Join(dir, "new.txt")
		writeFile(t, p, "")
		expectEvents(t, ch, fsEvent{p, "add"})
	})
	t.Run("addDir", func(t *testing.T) {
		p := filepath.Join(dir, "new-dir")
		mkdir(t, p)
		expectEvents(t, ch, fsEvent{p, "addDir"})
	})
	t.Run("change", func(t *testing.T) {
		p := filepath.Join(dir, "old.txt")
		fh, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fh.WriteString(" more"); err != nil {
			t.Fatal(err)
		}
		fh.Close()
		expectEvents(t, ch, fsEvent{p, "change"})
	})
	t.Run("unlink after the atomic delay", func(t *testing.T) {
		p := filepath.Join(dir, "old.txt")
		start := time.Now()
		if err := os.Remove(p); err != nil {
			t.Fatal(err)
		}
		expectEvents(t, ch, fsEvent{p, "unlink"})
		if waited := time.Since(start); waited < atomicDelay {
			t.Errorf("unlink after %v, before the atomic delay", waited)
		}
	})
	t.Run("unlinkDir for a dir known at start", func(t *testing.T) {
		p := filepath.Join(dir, "old-dir")
		if err := os.Remove(p); err != nil {
			t.Fatal(err)
		}
		expectEvents(t, ch, fsEvent{p, "unlinkDir"})
	})
	t.Run("unlinkDir for a dir added later", func(t *testing.T) {
		p := filepath.Join(dir, "new-dir")
		if err := os.Remove(p); err != nil {
			t.Fatal(err)
		}
		expectEvents(t, ch, fsEvent{p, "unlinkDir"})
	})
	t.Run("subdirectories are not watched", func(t *testing.T) {
		mkdir(t, filepath.Join(dir, "deep"))
		expectEvents(t, ch, fsEvent{filepath.Join(dir, "deep"), "addDir"})
		writeFile(t, filepath.Join(dir, "deep", "inner.txt"), "x")
		expectQuiet(t, ch)
	})
}

// An editor writes a temp file and renames it over the target. That is
// one change, not unlink and add.
func TestWatchAtomicRename(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.user, "watched")
	mkdir(t, dir)
	target := filepath.Join(dir, "a.txt")
	writeFile(t, target, "v1")
	_, ch := startWatch(t, f.svc, dir)

	swap := filepath.Join(dir, ".a.txt.swp")
	writeFile(t, swap, "v2")
	if err := os.Rename(swap, target); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, ch, fsEvent{target, "change"})
	expectQuiet(t, ch)
}

// An unlink and a create of the same name within the atomic delay are one
// change.
func TestWatchUnlinkThenCreate(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.user, "watched")
	mkdir(t, dir)
	target := filepath.Join(dir, "a.txt")
	writeFile(t, target, "v1")
	_, ch := startWatch(t, f.svc, dir)

	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	writeFile(t, target, "v2")
	// The create gives the leading change. The write that follows falls
	// in the throttle window and may add one trailing change.
	expectEvents(t, ch, fsEvent{target, "change"})
	expectAtMostOne(t, ch, fsEvent{target, "change"})
}

func TestWatchIgnoresTempNames(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.user, "watched")
	mkdir(t, dir)
	_, ch := startWatch(t, f.svc, dir)
	for _, name := range []string{".a.txt.swp", ".b.swx", "c.txt~", "x.sublime-tmp.subl1.tmp", ".d.txt.tmuxde-upload-0123456789abcdef"} {
		writeFile(t, filepath.Join(dir, name), "x")
		os.Remove(filepath.Join(dir, name))
	}
	// inotify keeps order. The marker comes first only if the rest was
	// ignored.
	marker := filepath.Join(dir, "marker")
	writeFile(t, marker, "")
	expectEvents(t, ch, fsEvent{marker, "add"})
}

// Writes through the service and uploads use temp files. The watcher
// shows only the target.
func TestWatchServiceWrites(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	dir := filepath.Join(f.user, "watched")
	mkdir(t, dir)
	target := filepath.Join(dir, "doc.md")
	writeFile(t, target, "v1")
	_, ch := startWatch(t, f.svc, dir)

	if _, err := f.svc.Write(ctx, target, "v2"); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, ch, fsEvent{target, "change"})
	expectQuiet(t, ch)

	u := f.svc.NewUploads()
	up := filepath.Join(dir, "upload.bin")
	if err := u.Chunk(ctx, up, []byte("a"), false); err != nil {
		t.Fatal(err)
	}
	if err := u.Chunk(ctx, up, []byte("b"), true); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, ch, fsEvent{up, "add"})
	if err := u.Chunk(ctx, up, []byte("c"), true); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, ch, fsEvent{up, "change"})
	expectQuiet(t, ch)
}

// Many writes in a burst give a leading change and at most one trailing
// change per window.
func TestWatchThrottlesChanges(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.user, "watched")
	mkdir(t, dir)
	p := filepath.Join(dir, "busy.log")
	writeFile(t, p, "")
	_, ch := startWatch(t, f.svc, dir)

	fh, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for range 20 {
		if _, err := fh.WriteString("line\n"); err != nil {
			t.Fatal(err)
		}
	}
	burst := time.Since(start)
	fh.Close()

	expectEvents(t, ch, fsEvent{p, "change"})
	n := 1
	for done := false; !done; {
		select {
		case got := <-ch:
			if got != (fsEvent{p, "change"}) {
				t.Fatalf("unexpected event %+v", got)
			}
			n++
		case <-time.After(settle):
			done = true
		}
	}
	if limit := 2 + int(burst/changeThrottle); n > limit {
		t.Errorf("%d changes for a burst of %v, want at most %d", n, burst, limit)
	}
}

// Events name paths under the real directory, as the relay did.
func TestWatchReportsRealPaths(t *testing.T) {
	f := newFixture(t)
	link := filepath.Join(f.user, "sub-link")
	symlink(t, f.sub, link)
	_, ch := startWatch(t, f.svc, link)
	writeFile(t, filepath.Join(f.sub, "x.txt"), "")
	expectEvents(t, ch, fsEvent{filepath.Join(f.sub, "x.txt"), "add"})
}

func TestWatchDirectoryRemoved(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.user, "watched")
	mkdir(t, dir)
	_, ch := startWatch(t, f.svc, dir)
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, ch, fsEvent{dir, "unlinkDir"})
	mkdir(t, dir)
	writeFile(t, filepath.Join(dir, "after"), "")
	expectQuiet(t, ch)
}

func TestWatchCloseStopsEvents(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.user, "watched")
	mkdir(t, dir)
	w, ch := startWatch(t, f.svc, dir)
	writeFile(t, filepath.Join(dir, "before"), "")
	expectEvents(t, ch, fsEvent{filepath.Join(dir, "before"), "add"})
	// A held unlink is dropped by Close.
	os.Remove(filepath.Join(dir, "before"))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "after"), "")
	expectQuiet(t, ch)
}

func TestWatchStopsWithContext(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.user, "watched")
	mkdir(t, dir)
	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan fsEvent, 16)
	w, err := f.svc.Watch(ctx, dir, func(path, event string) { ch <- fsEvent{path, event} })
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-w.done:
	case <-time.After(waitFor):
		t.Fatal("the watcher did not stop with its context")
	}
	writeFile(t, filepath.Join(dir, "after"), "")
	expectQuiet(t, ch)
	w.Close()
}

func TestWatchErrors(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	file := filepath.Join(f.sub, "file.txt")
	writeFile(t, file, "")
	tests := []struct {
		name string
		path string
		want string
	}{
		{"denied", f.ssh, "Access denied: path outside allowed directories"},
		{"outside", f.outside, "Access denied: path outside allowed directories"},
		{"a file", file, "Not a directory"},
		{"missing", filepath.Join(f.sub, "missing"), "No such file or directory"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w, err := f.svc.Watch(ctx, tt.path, nil)
			if w != nil {
				w.Close()
			}
			wantMessage(t, err, tt.want)
		})
	}
	_, err := f.svc.Watch(ctx, f.ssh, nil)
	if !errors.Is(err, node.ErrDenied) {
		t.Errorf("denied watch: %v is not node.ErrDenied", err)
	}
}

// newTestWatcher builds a watcher without fsnotify, to drive handle and
// fire with chosen times.
func newTestWatcher(dir string) (*Watcher, *[]fsEvent) {
	var got []fsEvent
	w := &Watcher{
		dir:      dir,
		log:      slog.New(slog.DiscardHandler),
		atomic:   atomicDelay,
		throttle: changeThrottle,
		known:    make(map[string]bool),
		unlinks:  make(map[string]time.Time),
		changes:  make(map[string]*changeWindow),
		onEvent:  func(path, event string) { got = append(got, fsEvent{path, event}) },
	}
	return w, &got
}

func TestWatcherThrottleTimes(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	w, got := newTestWatcher(dir)
	w.known[p] = false
	t0 := time.Now()
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	write := fsnotify.Event{Name: p, Op: fsnotify.Write}
	change := fsEvent{p, "change"}

	steps := []struct {
		ms    int
		write bool
		want  int
	}{
		{0, true, 1},    // leading change
		{10, true, 1},   // inside the window
		{20, true, 1},   // inside the window
		{49, false, 1},  // window still open
		{50, false, 2},  // trailing change, new window
		{60, true, 2},   // inside the new window
		{100, false, 3}, // trailing change again
		{150, false, 3}, // quiet window ends
		{200, true, 4},  // leading change
	}
	for _, s := range steps {
		if s.write {
			w.handle(write, at(s.ms))
		} else {
			w.fire(at(s.ms))
		}
		if len(*got) != s.want {
			t.Fatalf("at %dms: %d events, want %d", s.ms, len(*got), s.want)
		}
	}
	for _, e := range *got {
		if e != change {
			t.Errorf("event %+v, want %+v", e, change)
		}
	}
	if _, ok := w.changes[p]; !ok {
		t.Fatal("the last window is missing")
	}
	if next, ok := w.nextDeadline(); !ok || !next.Equal(at(250)) {
		t.Errorf("next deadline %v, %v, want 250ms", next.Sub(t0), ok)
	}
}

func TestWatcherAtomicTimes(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	w, got := newTestWatcher(dir)
	w.known[p] = false
	t0 := time.Now()
	ms := func(n int) time.Time { return t0.Add(time.Duration(n) * time.Millisecond) }

	// Removed and created again within the delay: one change.
	w.handle(fsnotify.Event{Name: p, Op: fsnotify.Remove}, ms(0))
	if next, ok := w.nextDeadline(); !ok || !next.Equal(ms(100)) {
		t.Fatalf("unlink deadline %v, %v", next.Sub(t0), ok)
	}
	writeFile(t, p, "again")
	w.handle(fsnotify.Event{Name: p, Op: fsnotify.Create}, ms(60))
	w.fire(ms(200))
	if want := []fsEvent{{p, "change"}}; len(*got) != 1 || (*got)[0] != want[0] {
		t.Fatalf("events %+v, want %+v", *got, want)
	}

	// Removed and not created again: unlink when the delay ends.
	*got = nil
	os.Remove(p)
	w.handle(fsnotify.Event{Name: p, Op: fsnotify.Rename}, ms(300))
	w.fire(ms(399))
	if len(*got) != 0 {
		t.Fatalf("events before the delay: %+v", *got)
	}
	w.fire(ms(400))
	if len(*got) != 1 || (*got)[0] != (fsEvent{p, "unlink"}) {
		t.Fatalf("events %+v, want one unlink", *got)
	}

	// A directory is removed at once, by the type seen when it appeared.
	*got = nil
	d := filepath.Join(dir, "d")
	mkdir(t, d)
	w.handle(fsnotify.Event{Name: d, Op: fsnotify.Create}, ms(500))
	os.Remove(d)
	w.handle(fsnotify.Event{Name: d, Op: fsnotify.Remove}, ms(510))
	if want := []fsEvent{{d, "addDir"}, {d, "unlinkDir"}}; len(*got) != 2 || (*got)[0] != want[0] || (*got)[1] != want[1] {
		t.Fatalf("events %+v, want %+v", *got, want)
	}
}
