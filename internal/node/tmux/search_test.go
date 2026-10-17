package tmux

import (
	"context"

	"regexp"
	"strings"
	"testing"

	"unicode/utf8"

	"tmuxde/internal/protocol"
)

func TestSearchLines(t *testing.T) {
	text := "before\n" + strings.Repeat("界", 100) + "Échec [x].*" + strings.Repeat("界", 200) + "\nafter\n"
	matches, partial := searchLines(bg, text, regexp.MustCompile(`(?i)échec \[x\]\.\*`), protocol.TerminalSearchMatch{}, nil)
	if partial || len(matches) != 1 || matches[0].Line != 2 || matches[0].Before != "before" || matches[0].After != "after" {
		t.Fatalf("context = %+v, partial %v", matches, partial)
	}
	if !utf8.ValidString(matches[0].Text) || !strings.HasPrefix(matches[0].Text, "…") || !strings.HasSuffix(matches[0].Text, "…") || !strings.Contains(matches[0].Text, "Échec [x].*") {
		t.Fatalf("excerpt = %q", matches[0].Text)
	}
	ctx, cancel := context.WithCancel(bg)
	cancel()
	_, partial = searchLines(ctx, text, regexp.MustCompile("before"), protocol.TerminalSearchMatch{}, nil)
	if !partial {
		t.Fatal("canceled scan must be partial")
	}
}
