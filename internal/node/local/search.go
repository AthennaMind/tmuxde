package local

import (
	"context"
	"time"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// Search is a machine-wide read, like session:list. It never attaches a PTY.
// One search per node bounds work from concurrent browser connections.
func (n *Node) terminalSearch(ctx context.Context, c *conn, m *client.TerminalSearch) error {
	reply := &server.TerminalSearchResult{
		Type: "terminal:search:result", RequestID: m.RequestID,
		Matches: []protocol.TerminalSearchMatch{},
	}
	if !n.searchMu.TryLock() {
		message := "Another search is running. Try again."
		reply.Error = &message
		return c.send(ctx, reply)
	}
	defer n.searchMu.Unlock()
	searchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	stop := context.AfterFunc(c.ctx, cancel)
	defer stop()
	result, err := n.tmux.SearchHistory(searchCtx, m.Query, m.CaseSensitive, m.ExcludeSessions)
	reply.Matches = orEmpty(result.Matches)
	reply.SearchedPanes = result.SearchedPanes
	reply.SkippedPanes = result.SkippedPanes
	reply.Partial = result.Partial || searchCtx.Err() != nil
	if err != nil {
		message := "Could not read terminal history. Try again."
		reply.Error = &message
	}
	return c.send(ctx, reply)
}
