package local

import (
	"slices"
	"testing"

	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

func TestTerminalSearchWithoutAttach(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	h.must(1, &client.TerminalSearch{Type: "terminal:search", RequestID: "one", Query: "literal", ExcludeSessions: []string{"private"}})
	result := sink.last().(*server.TerminalSearchResult)
	if result.RequestID != "one" || result.Error != nil || result.Matches == nil {
		t.Fatalf("reply = %+v", result)
	}
	if !slices.Equal(h.tm.called("SearchHistory"), []string{"SearchHistory literal false private"}) {
		t.Fatal("query or exclusions were not forwarded")
	}
	if len(h.tm.called("SelectPane")) != 0 {
		t.Fatal("search selected a pane")
	}
}

func TestTerminalSearchBusy(t *testing.T) {
	h := newHarness(t)
	sink := h.open(1)
	h.n.searchMu.Lock()
	defer h.n.searchMu.Unlock()
	h.must(1, &client.TerminalSearch{Type: "terminal:search", RequestID: "busy", Query: "literal", ExcludeSessions: []string{}})
	result := sink.last().(*server.TerminalSearchResult)
	if result.RequestID != "busy" || result.Error == nil || len(h.tm.called("SearchHistory")) != 0 {
		t.Fatalf("busy search = %+v", result)
	}
}
