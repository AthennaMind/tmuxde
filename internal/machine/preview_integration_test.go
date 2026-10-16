package machine

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

func TestRemoteTerminalPreview(t *testing.T) {
	hub := NewHub(t.TempDir(), strings.Repeat("b", 32))
	site := httptest.NewTLSServer(hub)
	t.Cleanup(site.Close)
	t.Cleanup(hub.Close)
	for _, name := range []string{"alpha", "beta"} {
		n, root := realNode(t)
		script := filepath.Join(root, "preview.sh")
		if err := os.WriteFile(script, []byte("printf '\\033[32mpreview-"+name+"\\033[0m\\n'\nexec sleep 3600\n"), 0600); err != nil {
			t.Fatal(err)
		}
		socket := filepath.Join(root, "tmux.sock")
		if out, err := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", "same", "sh "+script).CombinedOutput(); err != nil {
			t.Fatalf("fixture: %s, %v", out, err)
		}
		waitFor(t, func() bool {
			out, err := exec.Command("tmux", "-S", socket, "capture-pane", "-p", "-t", "same").Output()
			return err == nil && strings.Contains(string(out), "preview-")
		})
		record, _, _ := startAgent(t, hub, site, n, name)
		remote, _, _, _, err := hub.Resolve(record.ID)
		if err != nil {
			t.Fatal(err)
		}
		sink := make(messageSink, 16)
		if err := remote.Open(t.Context(), 1, sink); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { remote.Close(1) })
		if err := remote.Handle(t.Context(), 1, &client.TerminalPreview{Type: "terminal:preview", RequestID: "same-request", Targets: []protocol.PreviewTarget{{Session: "same", PaneID: "%0"}}, ExcludeSessions: []string{}, Once: true}); err != nil {
			t.Fatal(err)
		}
		reply := receive(t, sink, "terminal:preview:frame").(*server.TerminalPreviewFrame)
		if reply.RequestID != "same-request" || len(reply.Frames) != 1 || reply.Frames[0].Unavailable || !strings.Contains(reply.Frames[0].Content, "\x1b[32mpreview-"+name) {
			t.Fatalf("%s preview crossed machines or lost colors: %+v", name, reply)
		}
	}
}
