package tmux

import (
	"context"
	"slices"
	"tmuxde/internal/protocol"
)

// PreviewScreens reads visible screens with SGR colors. Membership is checked
// on every pass, including linked windows in excluded sessions. No PTY is used.
func (c *Client) PreviewScreens(ctx context.Context, targets []protocol.PreviewTarget, exclude []string) []protocol.PreviewFrame {
	frames := make([]protocol.PreviewFrame, 0, len(targets))
	if len(targets) > 32 {
		return frames
	}
	sessions, err := c.ListSessions(ctx)
	known := map[string]bool{}
	blocked := map[string]bool{}
	for _, session := range sessions {
		known[session.Name] = !IsClone(session.Name) && !slices.Contains(exclude, session.Name)
		if !known[session.Name] {
			panes, listErr := c.ListPanes(ctx, session.Name, "")
			if listErr != nil {
				err = listErr
			}
			for _, pane := range panes {
				blocked[pane.ID] = true
			}
		}
	}
	listed := map[string][]protocol.PaneInfo{}
	bytesRead := 0
	for _, target := range targets {
		frame := protocol.PreviewFrame{PaneID: target.PaneID, Cols: 80, Rows: 24, Unavailable: true}
		if err == nil && known[target.Session] && !blocked[target.PaneID] && bytesRead < 1<<20 {
			panes, ok := listed[target.Session]
			if !ok {
				panes, _ = c.ListPanes(ctx, target.Session, "")
				listed[target.Session] = panes
			}
			for _, pane := range panes {
				if pane.ID != target.PaneID || pane.Dimensions.Validate() != nil {
					continue
				}
				content, captureErr := c.CapturePaneByID(ctx, pane.ID, CaptureOptions{Escapes: true, ScreenOnly: true})
				bytesRead += len(content)
				if captureErr == nil && len(content) <= 131072 {
					frame.Cols, frame.Rows = pane.Dimensions.Cols, pane.Dimensions.Rows
					frame.Content, frame.Unavailable = content, false
				}
				break
			}
		}
		frames = append(frames, frame)
	}
	return frames
}
