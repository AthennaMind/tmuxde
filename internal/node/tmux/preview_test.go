package tmux

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"tmuxde/internal/protocol"
)

func TestPreviewScreens(t *testing.T) {
	f := newFixture(t)
	script := filepath.Join(f.base, "preview.sh")
	if err := os.WriteFile(script, []byte("echo old-history\ni=0; while [ $i -lt 30 ]; do echo padding; i=$((i+1)); done\nprintf '\\033[32mcolored-screen\\033[0m\\n'\nexec sleep 3600\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.tmux(t, "new-session", "-d", "-s", "first", "-x", "80", "-y", "24", "sh "+script)
	f.tmux(t, "new-session", "-d", "-s", "second")
	f.tmux(t, "new-session", "-d", "-s", "__tmuxde_hidden")
	pane := strings.TrimSpace(f.tmux(t, "display-message", "-p", "-t", "=first:", "#{pane_id}"))
	hidden := strings.TrimSpace(f.tmux(t, "display-message", "-p", "-t", "=__tmuxde_hidden:", "#{pane_id}"))
	target := []protocol.PreviewTarget{{Session: "first", PaneID: pane}}
	poll(t, "preview output", 5*time.Second, 20*time.Millisecond, func() (bool, string) {
		out := f.tmux(t, "capture-pane", "-p", "-t", pane)
		return strings.Contains(out, "colored-screen"), out
	})
	before := f.tmux(t, "list-panes", "-a", "-F", "#{pane_id}:#{pane_active}:#{pane_width}:#{pane_height}:#{pane_in_mode}")
	frames := f.c.PreviewScreens(bg, target, nil)
	if len(frames) != 1 || frames[0].Unavailable || frames[0].Cols != 80 || frames[0].Rows != 24 || !strings.Contains(frames[0].Content, "\x1b[32mcolored-screen") || strings.Contains(frames[0].Content, "old-history") {
		t.Fatalf("screen = %+v", frames)
	}
	after := f.tmux(t, "list-panes", "-a", "-F", "#{pane_id}:#{pane_active}:#{pane_width}:#{pane_height}:#{pane_in_mode}")
	if before != after {
		t.Fatal("preview changed tmux state")
	}
	for _, targets := range [][]protocol.PreviewTarget{
		{{Session: "second", PaneID: pane}}, {{Session: "__tmuxde_hidden", PaneID: hidden}}, {{Session: "missing", PaneID: pane}},
	} {
		if frames := f.c.PreviewScreens(bg, targets, nil); len(frames) != 1 || !frames[0].Unavailable || frames[0].Content != "" {
			t.Fatalf("invalid scope leaked: %+v", frames)
		}
	}
	f.tmux(t, "link-window", "-s", "=first:0", "-t", "=second:1")
	frames = f.c.PreviewScreens(bg, []protocol.PreviewTarget{{Session: "second", PaneID: pane}}, []string{"first"})
	if !frames[0].Unavailable || frames[0].Content != "" {
		t.Fatalf("locked link leaked: %+v", frames)
	}
	small := New(Options{Socket: f.sock, MaxOutput: 16, Logger: quiet})
	if _, err := small.CapturePaneByID(bg, pane, CaptureOptions{ScreenOnly: true, Escapes: true}); err == nil {
		t.Fatal("truncated screen returned as complete")
	}
}
