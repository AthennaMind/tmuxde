package monitor

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	"tmuxde/internal/protocol"
)

// errSourcePanic stands in for the result of a Source call that panicked.
var errSourcePanic = errors.New("monitor: source panicked")

// pollSessions lists every session once. Missing known names fire
// OnSessionExit, new names fire OnSessionCreated, and a known id under a
// new name fires OnSessionRenamed. OnSessionsChanged follows when the list
// moved. A failed listing changes nothing, so a tmux hiccup does not
// announce every session as gone.
func (m *Monitor) pollSessions(ctx context.Context) {
	var sessions []protocol.SessionInfo
	var err error
	if !m.protect("ListSessions", func() { sessions, err = m.src.ListSessions(ctx) }) {
		err = errSourcePanic
	}
	if ctx.Err() != nil {
		// Stop runs. A listing cut short is no news.
		return
	}
	if err != nil {
		m.log.Error("session monitor poll failed", "error", err)
		return
	}
	if sessions == nil {
		sessions = []protocol.SessionInfo{}
	}

	current := make(map[string]struct{}, len(sessions))
	// Ids of names this poll sees for the first time. A known name that is
	// gone while its id is here was renamed. tmux ids never move to another
	// session while the server runs.
	fresh := make(map[string]string, len(sessions))
	for _, s := range sessions {
		current[s.Name] = struct{}{}
		if _, ok := m.known[s.Name]; !ok && s.ID != "" {
			fresh[s.ID] = s.Name
		}
	}
	// Renames and exits first, so a name that comes back as another
	// session reads as the old one gone, then the new one.
	for _, name := range slices.Sorted(maps.Keys(m.known)) {
		if _, ok := current[name]; ok {
			continue
		}
		id := m.known[name]
		delete(m.known, name)
		if to, ok := fresh[id]; ok && id != "" {
			delete(fresh, id)
			m.known[to] = id
			m.log.Info("session renamed", "oldName", name, "newName", to)
			m.emitRenamed(name, to)
			continue
		}
		m.log.Info("session exited", "name", name)
		m.emitExit(name)
	}
	for _, s := range sessions {
		_, seen := m.known[s.Name]
		m.known[s.Name] = s.ID
		if !seen {
			m.emitCreated(s)
		}
	}

	sig := listSignature(sessions)
	changed := m.listed && sig != m.listSig
	m.listSig, m.listed = sig, true
	if changed {
		m.emitList(sessions)
	}
}

// listSignature is the part of a session listing the browser draws in its
// session list and that changes without a create, kill or rename made
// there: name, id, window count and attached flag, in tmux order.
func listSignature(sessions []protocol.SessionInfo) string {
	var b strings.Builder
	for _, s := range sessions {
		fmt.Fprintf(&b, "%s\x00%s\x00%d\x00%d\n", s.Name, s.ID, s.Windows, flag(s.Attached))
	}
	return b.String()
}

// pollWindows lists the windows and panes of every watched session, one
// session after another, and fires OnWindowsChanged when the signature
// moved since the last poll.
func (m *Monitor) pollWindows(ctx context.Context) {
	var watched []string
	if !m.protect("Watched", func() { watched = m.watched() }) {
		return
	}
	names := make([]string, 0, len(watched))
	watching := make(map[string]struct{}, len(watched))
	for _, name := range watched {
		if _, dup := watching[name]; dup || name == "" {
			continue
		}
		watching[name] = struct{}{}
		names = append(names, name)
	}
	// A session nobody watches loses its baseline. If it is watched again
	// later, its first signature seeds silently, like a fresh attach.
	for name := range m.sigs {
		if _, ok := watching[name]; !ok {
			delete(m.sigs, name)
		}
	}

	for _, name := range names {
		if ctx.Err() != nil {
			return
		}
		windows, panes, err := m.layout(ctx, name)
		if err != nil {
			// The session can vanish between two polls. The session poll
			// reports the exit. A later good listing seeds again silently.
			delete(m.sigs, name)
			if ctx.Err() == nil {
				m.log.Debug("window poll skipped session", "name", name, "error", err)
			}
			continue
		}
		sig := signature(windows, panes)
		prev, seen := m.sigs[name]
		m.sigs[name] = sig
		// The first sighting only seeds the baseline. The browser fetched its
		// own lists on attach, so announcing them again is noise.
		if !seen || prev == sig {
			continue
		}
		if windows == nil {
			windows = []protocol.WindowInfo{}
		}
		m.emitWindows(name, windows)
	}
}

// layout lists the windows and every pane of session at the same time.
func (m *Monitor) layout(ctx context.Context, session string) ([]protocol.WindowInfo, []protocol.PaneInfo, error) {
	var panes []protocol.PaneInfo
	paneErr := make(chan error, 1)
	go func() {
		var err error
		if !m.protect("ListPanes", func() { panes, err = m.src.ListPanes(ctx, session, "") }) {
			err = errSourcePanic
		}
		paneErr <- err
	}()

	var windows []protocol.WindowInfo
	var err error
	if !m.protect("ListWindows", func() { windows, err = m.src.ListWindows(ctx, session) }) {
		err = errSourcePanic
	}
	perr := <-paneErr
	if err != nil {
		return nil, nil, fmt.Errorf("list windows of %q: %w", session, err)
	}
	if perr != nil {
		return nil, nil, fmt.Errorf("list panes of %q: %w", session, perr)
	}
	return windows, panes, nil
}

// signature is a cheap change detector for the layout of one session. Every
// field in it is one the browser draws. The format is the relay one:
//
//	window id:index:name:active:paneCount:zoomed:layout joined with |
//	then #
//	then pane id:windowId:active:path joined with |
//
// zoomed is there because pressing prefix z changes neither window nor pane
// count. tmux reports the unzoomed layout while a window is zoomed, so layout
// cannot stand in for zoomed. A pane unzoomed outside the browser otherwise
// stayed drawn as zoomed. layout catches splits, kills and resizes made in
// another client.
//
// The pane half catches focus moved with tmux keys and cd in a pane. Both
// leave every window field as it was, so the browser kept browsing the
// folder of a pane that was no longer active.
func signature(windows []protocol.WindowInfo, panes []protocol.PaneInfo) string {
	var b strings.Builder
	for i, w := range windows {
		if i > 0 {
			b.WriteByte('|')
		}
		zoomed := w.Zoomed != nil && *w.Zoomed
		fmt.Fprintf(&b, "%s:%d:%s:%d:%d:%d:%s",
			w.ID, w.Index, w.Name, flag(w.Active), w.PaneCount, flag(zoomed), w.Layout)
	}
	b.WriteByte('#')
	for i, p := range panes {
		if i > 0 {
			b.WriteByte('|')
		}
		path := ""
		if p.Path != nil {
			path = *p.Path
		}
		fmt.Fprintf(&b, "%s:%s:%d:%s", p.ID, p.WindowID, flag(p.Active), path)
	}
	return b.String()
}

func flag(v bool) int {
	if v {
		return 1
	}
	return 0
}
