package local

import (
	"context"
	"time"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

type previewWatch struct {
	cancel context.CancelFunc
	done   chan struct{}
}

func (w *previewWatch) close() {
	if w != nil {
		w.cancel()
		<-w.done
	}
}

func (n *Node) terminalPreview(c *conn, m *client.TerminalPreview) error {
	c.mu.Lock()
	previous := c.preview
	c.preview = nil
	c.mu.Unlock()
	previous.close()
	if len(m.Targets) == 0 {
		return nil
	}
	// Leases also end abandoned subscriptions on a healthy connection.
	ctx, cancel := context.WithTimeout(c.ctx, 35*time.Second)
	watch := &previewWatch{cancel: cancel, done: make(chan struct{})}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		cancel()
		return nil
	}
	c.preview = watch
	c.mu.Unlock()
	go func() {
		defer close(watch.done)
		defer cancel()
		previous := map[string]protocol.PreviewFrame{}
		for ctx.Err() == nil {
			captureCtx, stop := context.WithTimeout(ctx, 2*time.Second)
			frames := n.tmux.PreviewScreens(captureCtx, m.Targets, m.ExcludeSessions)
			stop()
			changed := make([]protocol.PreviewFrame, 0, len(frames))
			for _, frame := range frames {
				if old, ok := previous[frame.PaneID]; !ok || old != frame {
					changed = append(changed, frame)
					previous[frame.PaneID] = frame
				}
			}
			if ctx.Err() != nil {
				return
			}
			if len(changed) > 0 {
				sendCtx, stopSend := context.WithTimeout(ctx, 2*time.Second)
				err := c.send(sendCtx, &server.TerminalPreviewFrame{Type: "terminal:preview:frame", RequestID: m.RequestID, Frames: changed})
				stopSend()
				if err != nil {
					return
				}
			}
			if m.Once {
				return
			}
			timer := time.NewTimer(150 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
	return nil
}
