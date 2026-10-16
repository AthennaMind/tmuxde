package server

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"tmuxde/internal/protocol"
)

func TestPreviewLogOmitsScreens(t *testing.T) {
	var output bytes.Buffer
	msg := &TerminalPreviewFrame{Type: "terminal:preview:frame", RequestID: "request", Frames: []protocol.PreviewFrame{{PaneID: "%1", Content: "private-screen"}}}
	slog.New(slog.NewJSONHandler(&output, nil)).Info("message", "msg", msg)
	if strings.Contains(output.String(), "private-screen") || !strings.Contains(output.String(), `"frames":1`) {
		t.Fatal(output.String())
	}
}
