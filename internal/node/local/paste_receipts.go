package local

import (
	"context"
	"sync"

	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// Keep outcomes across browser connections, without keeping prompt text.
const maxPasteReceipts = 1024

type pasteKey struct{ session, request string }
type pasteReceipts struct {
	mu        sync.Mutex
	entries   map[pasteKey]*server.PanePasteResult
	completed []pasteKey
}

// A nil result denotes a request still running. Never evict a running paste.
func (r *pasteReceipts) begin(key pasteKey) (bool, *server.PanePasteResult) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.entries[key]; ok {
		return false, existing
	}
	if r.entries == nil {
		r.entries = make(map[pasteKey]*server.PanePasteResult)
	}
	if len(r.entries) >= maxPasteReceipts {
		if len(r.completed) == 0 {
			return false, &server.PanePasteResult{Type: "pane:paste:result", RequestID: key.request, Error: "Too many active pastes"}
		}
		delete(r.entries, r.completed[0])
		r.completed = r.completed[1:]
	}
	r.entries[key] = nil
	return true, nil
}
func (r *pasteReceipts) finish(key pasteKey, result *server.PanePasteResult) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[key] = result
	r.completed = append(r.completed, key)
}
func (r *pasteReceipts) lookup(key pasteKey) (*server.PanePasteResult, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	result, ok := r.entries[key]
	return result, ok
}
func (n *Node) paste(ctx context.Context, c *conn, m *client.PanePaste) error {
	run := func(string) error {
		return n.tmux.PastePane(ctx, m.ID, m.Command, m.Text, m.Submit != nil && *m.Submit)
	}
	if m.RequestID == nil {
		return n.withPane(ctx, c, m.ID, run)
	}
	key := pasteKey{c.attachedSession(), *m.RequestID}
	fresh, previous := n.pastes.begin(key)
	if !fresh {
		if previous == nil {
			return nil
		}
		return c.send(ctx, previous)
	}
	result := &server.PanePasteResult{Type: "pane:paste:result", RequestID: key.request, Error: "Pane is unavailable in the attached session"}
	err := n.withPane(ctx, c, m.ID, func(session string) error {
		if session != key.session {
			return nil
		}
		if err := run(session); err != nil {
			result.Error = err.Error()
		} else {
			result.Success = true
			result.Error = ""
		}
		return nil
	})
	n.pastes.finish(key, result)
	if err != nil {
		return err
	}
	return c.send(ctx, result)
}
