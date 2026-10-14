package files

import (
	"cmp"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watcher reports changes inside one directory, without subdirectories.
// It follows chokidar as the relay configured it: no events for what
// exists at start, and the event names add, change, unlink, addDir and
// unlinkDir.
//
//   - A file unlink waits atomicDelay. A file created under the same name
//     in that window turns both into one change. So does a rename over a
//     known file. Editors that save through a temp file and a rename give
//     one change, not unlink and add.
//   - Change events for one path are at most one per changeThrottle. A
//     change that falls inside the window is sent once when it ends.
//     chokidar dropped it, so the last write of a burst could go unseen.
//   - Editor temp names are ignored, by chokidar's pattern applied to the
//     base name, and so are this package's own temp files.
//   - Whether a name is a directory is remembered when it appears, so the
//     right unlink or unlinkDir goes out after the entry is gone.
//   - Removing or moving the watched directory sends unlinkDir for it and
//     ends the events.
type Watcher struct {
	fw      *fsnotify.Watcher
	dir     string
	onEvent func(path, event string)
	log     *slog.Logger

	atomic   time.Duration
	throttle time.Duration

	stop     chan struct{}
	stopOnce sync.Once
	done     chan struct{}

	// The fields below belong to the run goroutine.

	// known maps the full path of every entry to whether it is a
	// directory.
	known map[string]bool
	// unlinks holds file unlinks waiting for atomicDelay, by full path.
	unlinks map[string]time.Time
	// changes holds the open change windows, by full path.
	changes map[string]*changeWindow
	gone    bool
}

type changeWindow struct {
	until time.Time
	again bool
}

// ignoredName matches chokidar's atomic ignore pattern, vim swap files,
// backups ending in ~ and Sublime temp files, plus the temp files of Write
// and uploads.
var ignoredName = regexp.MustCompile(`\..*\.(sw[px])$|~$|\.subl.*\.tmp|\.tmuxde-(upload|write)-[0-9a-f]{16}$`)

// Watch starts watching the directory at path. Events go to onEvent with
// the full path under the real directory. onEvent runs on the watcher
// goroutine, one call at a time, and may block. A slow onEvent delays
// later events.
//
// The watcher runs until Close is called or ctx ends, so pass a context
// that lives as long as the connection, not one for a single message.
// Close waits for a running onEvent to return.
func (s *Service) Watch(ctx context.Context, path string, onEvent func(path, event string)) (*Watcher, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	_, dir, err := s.guard.paths(path)
	if err != nil {
		return nil, fail(err)
	}
	fi, err := os.Stat(dir)
	if err != nil {
		return nil, fail(err)
	}
	if !fi.IsDir() {
		return nil, fail(syscall.ENOTDIR)
	}
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fail(err)
	}
	// Add before the listing. Anything made in between shows up in both,
	// and a known name only turns its add into a change.
	if err := fw.Add(dir); err != nil {
		fw.Close()
		return nil, fail(err)
	}
	w := &Watcher{
		fw:       fw,
		dir:      dir,
		onEvent:  onEvent,
		log:      s.log,
		atomic:   s.atomic,
		throttle: s.throttle,
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
		known:    make(map[string]bool),
		unlinks:  make(map[string]time.Time),
		changes:  make(map[string]*changeWindow),
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		fw.Close()
		return nil, fail(err)
	}
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())
		isDir := e.IsDir()
		if e.Type()&os.ModeSymlink != 0 {
			fi, err := os.Stat(full)
			isDir = err == nil && fi.IsDir()
		}
		w.known[full] = isDir
	}
	go w.run(ctx)
	return w, nil
}

// Close stops the watcher and waits for its goroutine. Pending unlinks
// and changes are dropped. Close is safe to call more than once.
func (w *Watcher) Close() error {
	w.stopOnce.Do(func() { close(w.stop) })
	<-w.done
	return nil
}

func (w *Watcher) run(ctx context.Context) {
	defer close(w.done)
	defer w.fw.Close()
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	for {
		var tick <-chan time.Time
		if next, ok := w.nextDeadline(); ok {
			timer.Reset(time.Until(next))
			tick = timer.C
		}
		select {
		case <-w.stop:
			return
		case <-ctx.Done():
			return
		case ev, ok := <-w.fw.Events:
			if !ok {
				return
			}
			w.handle(ev, time.Now())
		case err, ok := <-w.fw.Errors:
			if !ok {
				return
			}
			w.log.Warn("files: watcher error", "dir", w.dir, "err", err)
		case now := <-tick:
			w.fire(now)
		}
		timer.Stop()
	}
}

// handle turns one fsnotify event into events for onEvent.
func (w *Watcher) handle(ev fsnotify.Event, now time.Time) {
	if w.gone {
		return
	}
	// fsnotify joins the watched path and the name with a slash, which
	// doubles it for "/".
	ev.Name = filepath.Clean(ev.Name)
	if ev.Name == w.dir {
		if ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename) {
			w.fire(now.Add(w.atomic))
			w.gone = true
			w.emit(w.dir, "unlinkDir")
		}
		return
	}
	if filepath.Dir(ev.Name) != w.dir || ignoredName.MatchString(filepath.Base(ev.Name)) {
		return
	}
	if ev.Has(fsnotify.Create) {
		w.created(ev.Name, now)
	}
	if ev.Has(fsnotify.Write) {
		w.written(ev.Name, now)
	}
	if ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename) {
		w.removed(ev.Name, now)
	}
}

func (w *Watcher) created(name string, now time.Time) {
	fi, err := os.Stat(name)
	if err != nil {
		// A dangling link is a file. Anything else is gone again, and
		// its remove event follows.
		if fi, err = os.Lstat(name); err != nil {
			return
		}
	}
	isDir := fi.IsDir()
	if _, pending := w.unlinks[name]; pending {
		delete(w.unlinks, name)
		if !isDir {
			w.known[name] = false
			w.change(name, now)
			return
		}
		w.emit(name, "unlink")
	}
	if was, ok := w.known[name]; ok {
		switch {
		case !was && !isDir:
			// Renamed over a known file.
			w.change(name, now)
			return
		case was && isDir:
			return
		case was:
			w.emit(name, "unlinkDir")
		default:
			delete(w.changes, name)
			w.emit(name, "unlink")
		}
	}
	w.known[name] = isDir
	if isDir {
		w.emit(name, "addDir")
	} else {
		w.emit(name, "add")
	}
}

func (w *Watcher) written(name string, now time.Time) {
	isDir, ok := w.known[name]
	switch {
	case !ok:
		w.created(name, now)
	case !isDir:
		w.change(name, now)
	}
}

func (w *Watcher) removed(name string, now time.Time) {
	isDir, ok := w.known[name]
	if !ok {
		return
	}
	delete(w.known, name)
	delete(w.changes, name)
	if isDir {
		w.emit(name, "unlinkDir")
		return
	}
	w.unlinks[name] = now.Add(w.atomic)
}

// change sends a change now, or once the open window for name ends.
func (w *Watcher) change(name string, now time.Time) {
	if win, ok := w.changes[name]; ok && now.Before(win.until) {
		win.again = true
		return
	}
	w.changes[name] = &changeWindow{until: now.Add(w.throttle)}
	w.emit(name, "change")
}

// fire sends what is due at now: held unlinks and the trailing change of
// a window that saw more changes.
func (w *Watcher) fire(now time.Time) {
	type due struct {
		at    time.Time
		name  string
		event string
	}
	var out []due
	for name, at := range w.unlinks {
		if !at.After(now) {
			delete(w.unlinks, name)
			out = append(out, due{at, name, "unlink"})
		}
	}
	for name, win := range w.changes {
		if win.until.After(now) {
			continue
		}
		if !win.again {
			delete(w.changes, name)
			continue
		}
		out = append(out, due{win.until, name, "change"})
		w.changes[name] = &changeWindow{until: now.Add(w.throttle)}
	}
	slices.SortFunc(out, func(a, b due) int {
		return cmp.Or(a.at.Compare(b.at), cmp.Compare(a.name, b.name))
	})
	for _, d := range out {
		w.emit(d.name, d.event)
	}
}

func (w *Watcher) nextDeadline() (time.Time, bool) {
	var next time.Time
	found := false
	consider := func(t time.Time) {
		if !found || t.Before(next) {
			next, found = t, true
		}
	}
	for _, at := range w.unlinks {
		consider(at)
	}
	for _, win := range w.changes {
		consider(win.until)
	}
	return next, found
}

func (w *Watcher) emit(path, event string) {
	if w.onEvent != nil {
		w.onEvent(path, event)
	}
}
