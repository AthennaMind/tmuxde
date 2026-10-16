package local

import (
	"testing"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

func previewRequest(id string, once bool) *client.TerminalPreview {
	return &client.TerminalPreview{Type: "terminal:preview", RequestID: id, Targets: []protocol.PreviewTarget{{Session: "work", PaneID: "%1"}}, ExcludeSessions: []string{}, Once: once}
}
func TestPreviewSubscription(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	h.must(1, previewRequest("first", false))
	sink.waitCount(1)
	waitUntil(t, "second capture", func() bool { return len(h.tm.called("PreviewScreens")) >= 2 })
	if len(sink.all()) != 1 {
		t.Fatal("unchanged frame sent twice")
	}
	h.must(1, previewRequest("second", true))
	sink.waitCount(2)
	if sink.last().(*server.TerminalPreviewFrame).RequestID != "second" {
		t.Fatal("replacement received stale frame")
	}
	h.n.Close(1)
	if len(h.tm.called("SelectPane")) != 0 || len(h.tm.called("Attach")) != 0 {
		t.Fatal("preview changed session state")
	}
}
func TestPreviewStopCancelsBlockedSend(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	entered := make(chan struct{})
	block := make(chan struct{})
	sink.setGate(func(server.Message) <-chan struct{} { close(entered); return block })
	h.must(1, previewRequest("blocked", false))
	<-entered
	stop := previewRequest("stop", false)
	stop.Targets = []protocol.PreviewTarget{}
	h.must(1, stop)
	if len(sink.all()) != 0 {
		t.Fatal("canceled frame delivered")
	}
}
