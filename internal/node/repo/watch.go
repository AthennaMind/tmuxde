package repo

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"

	"tmuxde/internal/protocol/server"
)

// Watcher defaults. WatchOptions can change them.
const (
	// defaultWatchMaxDirs caps the work tree directories one watcher adds.
	defaultWatchMaxDirs = 4096
	// defaultWatchWalkTime caps one walk that adds directories.
	defaultWatchWalkTime = 5 * time.Second
	// defaultWatchDebounce is the quiet time before changes go out.
	defaultWatchDebounce = 250 * time.Millisecond
	// defaultWatchMaxWait is the longest a change waits from the first
	// event of a burst, so a steady stream still reports once a second.
	defaultWatchMaxWait = time.Second
	// watchMaxRefDirs caps the directories under refs. Refs are small.
	watchMaxRefDirs = 1024
	// watchMaxPending caps the paths one batch collects before Git
	// filters the ignored ones. Past it the batch is truncated.
	watchMaxPending = 1024
	// watchMaxKnown caps the check-ignore answers a watcher keeps.
	watchMaxKnown = 8192
	// watchDrainMax caps the events taken in one go before new
	// directories are added.
	watchDrainMax = 4096
	// watchEventBuffer is the event channel buffer of the watcher.
	watchEventBuffer = 1024
	// ignoredArgBytes caps the pathspec bytes of one ls-files call.
	ignoredArgBytes = 64 << 10
)

// WatchOptions configures repository watchers. Zero values pick the
// defaults.
type WatchOptions struct {
	// MaxDirs caps the work tree directories one watcher adds. Default
	// 4096. Past it the watcher is partial.
	MaxDirs int
	// WalkTime caps one walk that adds directories. Default 5 s. Past it
	// the watcher is partial.
	WalkTime time.Duration
	// Debounce is the quiet time after the last event before changes go
	// out. Default 250 ms.
	Debounce time.Duration
	// MaxWait is the longest changes wait after the first event. Default
	// 1 s.
	MaxWait time.Duration
}

func (o WatchOptions) withDefaults() WatchOptions {
	if o.MaxDirs <= 0 {
		o.MaxDirs = defaultWatchMaxDirs
	}
	if o.WalkTime <= 0 {
		o.WalkTime = defaultWatchWalkTime
	}
	if o.Debounce <= 0 {
		o.Debounce = defaultWatchDebounce
	}
	if o.MaxWait <= 0 {
		o.MaxWait = defaultWatchMaxWait
	}
	return o
}

// gitStateNames are the files at the top of a Git directory whose change
// means HEAD, the index or refs moved.
var gitStateNames = map[string]bool{
	"HEAD":             true,
	"ORIG_HEAD":        true,
	"MERGE_HEAD":       true,
	"CHERRY_PICK_HEAD": true,
	"REBASE_HEAD":      true,
	"REVERT_HEAD":      true,
	"index":            true,
	"packed-refs":      true,
}

// gitRefNames are the gitStateNames whose change means history may differ:
// HEAD moved or a ref changed. The index and the other heads do not count.
var gitRefNames = map[string]bool{
	"HEAD":        true,
	"packed-refs": true,
}

// editorTempName matches the editor temp files the file watcher ignores:
// vim swap files, backups ending in ~, Sublime temp files and the temp
// files of file writes and uploads.
var editorTempName = regexp.MustCompile(`\..*\.(sw[px])$|~$|\.subl.*\.tmp|\.tmuxde-(upload|write)-[0-9a-f]{16}$`)

// WatchHandle is a running repository watch. *Watcher implements it.
type WatchHandle interface {
	// Partial reports that a walk hit the directory or time cap, so some
	// of the work tree is not watched.
	Partial() bool
	// Close stops the watch and waits for its goroutine.
	Close() error
}

// Message is the text a browser sees for err, as a result of kind error
// would carry it.
func Message(err error) string {
	msg, _ := publicMessage(err)
	return msg
}

// WatchRoot finds the repository a watch from pane folder cwd covers and
// returns its root. path is the captured context folder. When set it must
// be absolute. Both go through the guard. A folder outside any repository
// is an error with the message of status outside one.
func (s *Service) WatchRoot(ctx context.Context, cwd string, path *string) (string, error) {
	start, err := s.checked(cwd)
	if err != nil {
		return "", err
	}
	if path != nil {
		if start, err = s.checked(*path); err != nil {
			return "", err
		}
	}
	repo, err := s.discover(ctx, start)
	if err != nil {
		return "", err
	}
	if repo == nil {
		return "", fail(msgNotRepository)
	}
	return repo.root, nil
}

// Watch starts watching the repository at root, as WatchRoot returned it.
// The Git directory, and the common directory of a linked work tree, are
// watched for HEAD, the index and refs. The work tree is watched one
// directory at a time, without symlinks, .git entries, ignored directories
// and paths the guard refuses, up to the directory and time caps.
//
// Changes are coalesced into repo:changed and go to send on the watcher
// goroutine, one call at a time. send may block. When a later walk hits a
// cap, send also gets one repo:watch:result with partial set. The watcher
// runs until Close or until ctx ends, so pass a context that lives as long
// as the connection.
func (s *Service) Watch(ctx context.Context, root string, send func(server.Message)) (WatchHandle, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	repo, err := s.discover(ctx, root)
	if err != nil {
		return nil, err
	}
	if repo == nil || repo.root != root {
		return nil, fail(msgNotRepository)
	}
	common, err := s.commonDir(*repo)
	if err != nil {
		return nil, err
	}
	// A buffer lets events pile up while the goroutine runs Git, so one
	// drain takes a whole burst.
	fw, err := fsnotify.NewBufferedWatcher(watchEventBuffer)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	w := &Watcher{
		s:       s,
		ctx:     ctx,
		cancel:  cancel,
		fw:      fw,
		repo:    *repo,
		send:    send,
		opts:    s.opts.Watch,
		log:     s.log,
		done:    make(chan struct{}),
		calls:   make(chan func()),
		gitDirs: map[string]bool{repo.gitdir: true, common: true},
		infoDir: filepath.Join(common, "info"),
		refDirs: map[string]bool{},
		dirs:    map[string]bool{},
		ignore:  newIgnoreSet(),
		known:   map[string]bool{},
		pending: map[string]bool{},
	}
	for dir := range w.gitDirs {
		if err := fw.Add(dir); err != nil {
			cancel()
			fw.Close()
			return nil, err
		}
	}
	for dir := range w.gitDirs {
		w.addRefs(filepath.Join(dir, "refs"))
	}
	if isDir(w.infoDir) {
		// info/exclude holds ignore rules. A missing folder is added when
		// it shows up.
		_ = fw.Add(w.infoDir)
	}
	w.learn(s.ignored(ctx, *repo))
	w.partial.Store(!w.walk(false, repo.root))
	go w.run()
	return w, nil
}

// commonDir is the common Git directory of repo: the one commondir names
// for a linked work tree, else the Git directory itself.
func (s *Service) commonDir(repo repository) (string, error) {
	file := filepath.Join(repo.gitdir, "commondir")
	found, err := exists(file)
	if err != nil || !found {
		return repo.gitdir, err
	}
	content, err := s.metadataFile(file)
	if err != nil {
		return "", err
	}
	return s.checked(resolvePath(repo.gitdir, jsTrim(content)))
}

// ignored lists the ignored paths of the work tree, or below rels when
// any are given, with the safe Git call of every other action. Long rels
// lists take more than one call. A failure is logged and lists nothing,
// so the walk only watches more than it needs.
func (s *Service) ignored(ctx context.Context, repo repository, rels ...string) []string {
	base := []string{"ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"}
	if len(rels) == 0 {
		return s.ignoredCall(ctx, repo, base)
	}
	var list []string
	for len(rels) > 0 {
		args := append(slices.Clip(base), "--")
		size := 0
		for len(rels) > 0 && (size == 0 || size+len(rels[0]) <= ignoredArgBytes) {
			args = append(args, rels[0])
			size += len(rels[0]) + 1
			rels = rels[1:]
		}
		list = append(list, s.ignoredCall(ctx, repo, args)...)
	}
	return list
}

func (s *Service) ignoredCall(ctx context.Context, repo repository, args []string) []string {
	out, err := s.git(ctx, repo, args)
	if err != nil {
		s.log.Debug("repository watch: ignored paths not listed", "err", err)
		return nil
	}
	list := strings.Split(out.content, "\x00")
	// The last record is empty after the final NUL, or cut by the limit.
	return list[:len(list)-1]
}

// checkIgnore asks Git which of paths, relative to the root, are ignored.
// Tracked files never are. All paths go to one call on stdin. A path that
// starts with ":" is left out and counts as not ignored.
func (s *Service) checkIgnore(ctx context.Context, repo repository, paths []string) (map[string]bool, error) {
	var input strings.Builder
	for _, p := range paths {
		// check-ignore refuses literal pathspecs, so a leading ":" would
		// read as pathspec magic. No other character has a meaning here.
		if !strings.HasPrefix(p, ":") {
			input.WriteString(p)
			input.WriteByte(0)
		}
	}
	if input.Len() == 0 {
		return nil, nil
	}
	// Exit 1 means no path is ignored.
	out, err := s.gitWith(ctx, repo, []string{"check-ignore", "-z", "--stdin"}, input.String(),
		[]string{"GIT_LITERAL_PATHSPECS=0"}, 0, 1)
	if err != nil {
		return nil, err
	}
	got := map[string]bool{}
	for p := range strings.SplitSeq(out.content, "\x00") {
		if p != "" {
			got[p] = true
		}
	}
	return got, nil
}

// ignoreSet holds ignored work tree paths, relative to the root with
// forward slashes. Directories hide everything below them.
type ignoreSet struct {
	dirs  map[string]bool
	files map[string]bool
}

func newIgnoreSet() ignoreSet {
	return ignoreSet{dirs: map[string]bool{}, files: map[string]bool{}}
}

// merge adds Git's records. A directory ends in "/".
func (s ignoreSet) merge(records []string) {
	for _, r := range records {
		switch {
		case r == "" || r == "/":
		case strings.HasSuffix(r, "/"):
			s.dirs[strings.TrimSuffix(r, "/")] = true
		default:
			s.files[r] = true
		}
	}
}

// match reports whether rel or a directory above it is ignored.
func (s ignoreSet) match(rel string) bool {
	if s.files[rel] || s.dirs[rel] {
		return true
	}
	for i := strings.IndexByte(rel, '/'); i >= 0; {
		if s.dirs[rel[:i]] {
			return true
		}
		next := strings.IndexByte(rel[i+1:], '/')
		if next < 0 {
			break
		}
		i += 1 + next
	}
	return false
}

// Watcher watches one repository. The fields below the channels belong to
// the run goroutine once Watch returns.
type Watcher struct {
	s *Service
	// ctx ends with Close, which also stops a Git call in flight.
	ctx    context.Context
	cancel context.CancelFunc
	fw     *fsnotify.Watcher
	repo   repository
	send   func(server.Message)
	opts   WatchOptions
	log    *slog.Logger

	// partial is set when a walk hit a cap. It never goes back.
	partial atomic.Bool

	done chan struct{}
	// calls runs functions on the goroutine, for tests.
	calls chan func()

	// gitDirs are the Git directory and the common directory.
	gitDirs map[string]bool
	// infoDir holds info/exclude of the common directory.
	infoDir string
	// refDirs are the watched directories under refs.
	refDirs map[string]bool
	// dirs are the watched work tree directories.
	dirs   map[string]bool
	ignore ignoreSet
	// known holds the check-ignore answers, true for an ignored path.
	known map[string]bool
	// newDirs are directories made since the last drain.
	newDirs []string

	// The batch being coalesced.
	pending map[string]bool
	git     bool
	// refs is set when HEAD or a ref changed. It implies git.
	refs      bool
	truncated bool
	// rules is set when a .gitignore or info/exclude changed.
	rules bool
	first time.Time
	last  time.Time
}

// Partial reports that a walk hit a cap.
func (w *Watcher) Partial() bool { return w.partial.Load() }

// Close stops the watcher and waits for its goroutine. A batch not sent
// yet is dropped. Close is safe to call more than once.
func (w *Watcher) Close() error {
	w.cancel()
	<-w.done
	return nil
}

func (w *Watcher) run() {
	defer close(w.done)
	defer w.fw.Close()
	defer w.cancel()
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	for {
		var tick <-chan time.Time
		if next, ok := w.deadline(); ok {
			timer.Reset(time.Until(next))
			tick = timer.C
		}
		select {
		case <-w.ctx.Done():
			return
		case ev, ok := <-w.fw.Events:
			if !ok {
				return
			}
			w.handle(ev, time.Now())
			// Take the events already waiting, then add the directories
			// they made with one Git call.
			if !w.drain() {
				return
			}
			w.addNewDirs()
		case err, ok := <-w.fw.Errors:
			if !ok {
				return
			}
			if errors.Is(err, fsnotify.ErrEventOverflow) {
				// Events were lost, new directories among them. Say
				// everything may have changed and walk the tree again.
				w.git, w.refs, w.truncated, w.rules = true, true, true, true
				w.touch(time.Now())
				continue
			}
			w.log.Warn("repository watch error", "err", err)
		case <-tick:
			w.flush()
		case f := <-w.calls:
			f()
		}
		timer.Stop()
	}
}

// drain handles the events that wait already, up to watchDrainMax. It
// reports false when the event channel closed.
func (w *Watcher) drain() bool {
	for range watchDrainMax {
		select {
		case ev, ok := <-w.fw.Events:
			if !ok {
				return false
			}
			w.handle(ev, time.Now())
		default:
			return true
		}
	}
	return true
}

// handle files one event into the batch.
func (w *Watcher) handle(ev fsnotify.Event, now time.Time) {
	// fsnotify joins the watched path and the name with a slash, which
	// doubles it for "/".
	name := filepath.Clean(ev.Name)
	dir, base := filepath.Dir(name), filepath.Base(name)
	removed := ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename)
	switch {
	case w.gitDirs[dir]:
		if gitStateNames[base] {
			w.git = true
			w.refs = w.refs || gitRefNames[base]
			w.touch(now)
		}
		if name == w.infoDir && ev.Has(fsnotify.Create) && isDir(name) && w.fw.Add(name) == nil {
			// It may hold an exclude file already.
			w.rules = true
			w.touch(now)
		}
		return
	case dir == w.infoDir:
		if base == "exclude" {
			w.rules = true
			w.touch(now)
		}
		return
	case w.refDirs[dir] || w.refDirs[name]:
		if strings.HasSuffix(base, ".lock") {
			return
		}
		if removed {
			w.drop(w.refDirs, name)
		}
		if ev.Has(fsnotify.Create) && isDir(name) {
			w.addRefs(name)
		}
		w.git, w.refs = true, true
		w.touch(now)
		return
	}
	if !w.dirs[dir] || !inside(name, w.repo.root) || name == w.repo.root {
		return
	}
	rel, err := filepath.Rel(w.repo.root, name)
	if err != nil {
		return
	}
	rel = filepath.ToSlash(rel)
	if hasGitPart(rel) || editorTempName.MatchString(base) {
		return
	}
	if base == ".gitignore" {
		// Git reads the .gitignore of every folder it walks, even one
		// that is ignored itself.
		w.rules = true
		w.touch(now)
	}
	if w.ignore.match(rel) || w.known[rel] || !w.s.guard.Allowed(name) {
		return
	}
	if removed {
		w.drop(w.dirs, name)
	}
	if ev.Has(fsnotify.Create) && isDir(name) {
		// A new directory may be ignored. addNewDirs asks Git once for all
		// directories of a drain. The flush drops rel if it is.
		w.newDirs = append(w.newDirs, name)
	}
	w.add(rel, now)
}

// addNewDirs watches the directories made since the last call. One Git
// call lists the ignored ones and what is ignored below them.
func (w *Watcher) addNewDirs() {
	if len(w.newDirs) == 0 {
		return
	}
	dirs := w.newDirs
	w.newDirs = nil
	var fresh, rels []string
	for _, d := range dirs {
		// The walk of a directory made earlier in the drain may hold it.
		if w.dirs[d] || !isDir(d) {
			continue
		}
		rel := w.rel(d)
		if w.ignore.match(rel) {
			continue
		}
		fresh = append(fresh, d)
		rels = append(rels, rel)
	}
	if len(fresh) == 0 {
		return
	}
	if len(w.dirs) >= w.opts.MaxDirs {
		w.markPartial()
		return
	}
	w.learn(w.s.ignored(w.ctx, w.repo, rels...))
	keep := fresh[:0]
	for i, d := range fresh {
		if !w.ignore.match(rels[i]) {
			keep = append(keep, d)
		}
	}
	if !w.walk(false, keep...) {
		w.markPartial()
	}
}

// learn adds the records of ignored to the ignore set. ls-files also names
// a directory that only holds ignored files, next to those files. Such a
// directory stays watched, so a new file in it that is not ignored still
// shows up. Only directories a rule matches by themselves are skipped, as
// one check-ignore call tells. When that call fails, every directory
// record counts.
func (w *Watcher) learn(records []string) {
	var dirs []string
	for _, r := range records {
		if d, ok := strings.CutSuffix(r, "/"); ok && d != "" {
			dirs = append(dirs, d)
		}
	}
	if len(dirs) > 0 {
		matched, err := w.s.checkIgnore(w.ctx, w.repo, dirs)
		if err != nil {
			w.log.Debug("repository watch: ignored folders not checked", "err", err)
		} else {
			records = slices.DeleteFunc(records, func(r string) bool {
				d, ok := strings.CutSuffix(r, "/")
				return ok && d != "" && !matched[d]
			})
		}
	}
	w.ignore.merge(records)
}

// markPartial records that part of the work tree is not watched and tells
// the client once, so it keeps polling.
func (w *Watcher) markPartial() {
	if w.partial.Swap(true) || w.ctx.Err() != nil || w.send == nil {
		return
	}
	w.log.Info("repository watch is partial", "root", w.repo.root, "dirs", len(w.dirs))
	root := w.repo.root
	w.send(&server.RepoWatchResult{Type: "repo:watch:result", Root: &root, OK: true, Partial: true})
}

// rel is full relative to the root with forward slashes.
func (w *Watcher) rel(full string) string {
	rel, err := filepath.Rel(w.repo.root, full)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(rel)
}

// add puts rel in the batch. Past watchMaxPending only truncated is set.
func (w *Watcher) add(rel string, now time.Time) {
	if !w.pending[rel] {
		if len(w.pending) >= watchMaxPending {
			w.truncated = true
		} else {
			w.pending[rel] = true
		}
	}
	w.touch(now)
}

func (w *Watcher) touch(now time.Time) {
	if w.first.IsZero() {
		w.first = now
	}
	w.last = now
}

// deadline is when the batch goes out: Debounce after the last event, but
// never later than MaxWait after the first.
func (w *Watcher) deadline() (time.Time, bool) {
	if w.first.IsZero() {
		return time.Time{}, false
	}
	quiet := w.last.Add(w.opts.Debounce)
	limit := w.first.Add(w.opts.MaxWait)
	if limit.Before(quiet) {
		return limit, true
	}
	return quiet, true
}

// flush sends the batch and starts a new one. Ignored paths drop out of
// it, and nothing goes out when nothing is left.
func (w *Watcher) flush() {
	if w.first.IsZero() {
		return
	}
	if w.rules {
		w.reloadRules()
	}
	paths := w.visible()
	truncated := w.truncated
	if len(paths) > server.RepoChangedMaxPaths {
		paths, truncated = paths[:server.RepoChangedMaxPaths], true
	}
	git, refs := w.git, w.refs
	w.pending = map[string]bool{}
	w.git, w.refs, w.truncated = false, false, false
	w.first, w.last = time.Time{}, time.Time{}
	if w.send == nil || (len(paths) == 0 && !git && !truncated) {
		return
	}
	w.send(&server.RepoChanged{
		Type:      "repo:changed",
		Root:      w.repo.root,
		Git:       git,
		Refs:      refs,
		Paths:     paths,
		Truncated: truncated,
	})
}

// visible is the batch without ignored paths, sorted. Paths Git has not
// judged yet go to one check-ignore call, and the answers are kept. A
// failed call counts as not ignored, so the change still goes out.
func (w *Watcher) visible() []string {
	var unknown []string
	for p := range w.pending {
		if _, ok := w.known[p]; !ok && !w.ignore.match(p) {
			unknown = append(unknown, p)
		}
	}
	if len(unknown) > 0 {
		ignored, err := w.s.checkIgnore(w.ctx, w.repo, unknown)
		if err != nil {
			w.log.Debug("repository watch: ignored paths not checked", "err", err)
		}
		if len(w.known)+len(unknown) > watchMaxKnown {
			clear(w.known)
		}
		for _, p := range unknown {
			w.known[p] = ignored[p]
		}
	}
	paths := make([]string, 0, len(w.pending))
	for p := range w.pending {
		if !w.known[p] && !w.ignore.match(p) {
			paths = append(paths, p)
		}
	}
	slices.Sort(paths)
	return paths
}

// reloadRules reads the ignore rules again after a .gitignore or
// info/exclude changed. Folders they now ignore are dropped, folders they
// no longer ignore are added. The batch is truncated, since the newly
// watched folders may hold changes no event reported.
func (w *Watcher) reloadRules() {
	w.rules = false
	w.ignore = newIgnoreSet()
	clear(w.known)
	w.learn(w.s.ignored(w.ctx, w.repo))
	for d := range w.dirs {
		if d != w.repo.root && w.ignore.match(w.rel(d)) {
			delete(w.dirs, d)
			_ = w.fw.Remove(d)
		}
	}
	if !w.walk(true, w.repo.root) {
		w.markPartial()
	}
	w.truncated = true
}

// walk adds dirs and the directories below them, breadth first, until the
// directory cap or the walk time is hit. A directory already watched is
// skipped, or with rescan looked into for new ones. It reports false when
// a cap stopped it.
func (w *Watcher) walk(rescan bool, dirs ...string) bool {
	deadline := time.Now().Add(w.opts.WalkTime)
	queue := slices.Clone(dirs)
	for len(queue) > 0 {
		next := queue[0]
		queue = queue[1:]
		if w.ctx.Err() != nil || time.Now().After(deadline) {
			return false
		}
		switch {
		case w.dirs[next] && !rescan:
			continue
		case w.dirs[next]:
		case len(w.dirs) >= w.opts.MaxDirs:
			return false
		default:
			if err := w.fw.Add(next); err != nil {
				if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EMFILE) {
					// The inotify watch limit of the machine.
					w.log.Warn("repository watch limit reached", "err", err)
					return false
				}
				continue
			}
			w.dirs[next] = true
		}
		// Add before the listing, so a directory made in between shows
		// up as an event or in the listing.
		entries, err := os.ReadDir(next)
		if err != nil {
			continue
		}
		for _, e := range entries {
			// DirEntry types come from Lstat, so a symlink is never a
			// directory here and is never followed.
			if !e.IsDir() || e.Name() == ".git" {
				continue
			}
			full := filepath.Join(next, e.Name())
			rel, err := filepath.Rel(w.repo.root, full)
			if err != nil || w.ignore.match(filepath.ToSlash(rel)) || !w.s.guard.Allowed(full) {
				continue
			}
			queue = append(queue, full)
		}
	}
	return true
}

// addRefs adds dir and the directories below it as ref directories.
func (w *Watcher) addRefs(dir string) {
	queue := []string{dir}
	for len(queue) > 0 && len(w.refDirs) < watchMaxRefDirs {
		next := queue[0]
		queue = queue[1:]
		if w.refDirs[next] {
			continue
		}
		if err := w.fw.Add(next); err != nil {
			continue
		}
		w.refDirs[next] = true
		entries, err := os.ReadDir(next)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				queue = append(queue, filepath.Join(next, e.Name()))
			}
		}
	}
}

// drop forgets a removed or moved directory and everything below it.
// inotify ends the watch of a removed directory by itself. A moved one
// keeps its watches under the old names, so they are removed here, and
// the directory comes back under its new name through its create event.
func (w *Watcher) drop(set map[string]bool, dir string) {
	if !set[dir] {
		return
	}
	for p := range set {
		if p == dir || strings.HasPrefix(p, dir+"/") {
			delete(set, p)
			_ = w.fw.Remove(p)
		}
	}
}

// hasGitPart reports whether a part of rel is .git.
func hasGitPart(rel string) bool {
	for part := range strings.SplitSeq(rel, "/") {
		if part == ".git" {
			return true
		}
	}
	return false
}

// isDir is lstat, so a symlink to a directory is not one.
func isDir(p string) bool {
	fi, err := os.Lstat(p)
	return err == nil && fi.IsDir()
}
