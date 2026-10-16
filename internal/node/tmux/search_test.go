package tmux

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"tmuxde/internal/protocol"
)

func TestSearchHistory(t *testing.T) {
	f := newFixture(t)
	script := filepath.Join(f.base, "output.sh")
	content := "printf '\\033[31mOld Literal [x].*\\033[0m\\n'\ni=0\nwhile [ $i -lt 3000 ]; do echo padding-$i; i=$((i + 1)); done\nprintf 'wrapped-needle-abcdefghijklmnopqrstuvwxyz-0123456789-END\\n'\nprintf 'search-ready\\n'\nexec sleep 3600\n"
	if err := os.WriteFile(script, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"first", "second", "__tmuxde_hidden"} {
		f.tmux(t, "new-session", "-d", "-s", name, "-x", "40", "-y", "10", "sh "+script)
		poll(t, "search output", 5*time.Second, 20*time.Millisecond, func() (bool, string) {
			out := f.tmux(t, "capture-pane", "-p", "-t", "="+name+":")
			return strings.Contains(out, "search-ready"), out
		})
	}
	before := f.tmux(t, "list-panes", "-a", "-F", "#{pane_id}:#{pane_active}:#{pane_in_mode}")
	result, err := f.c.SearchHistory(bg, "old literal [x].*", false, nil)
	if err != nil || result.Partial || len(result.Matches) != 2 || result.SearchedPanes != 2 {
		t.Fatalf("search = %+v, %v", result, err)
	}
	for _, match := range result.Matches {
		if match.Text != "Old Literal [x].*" || match.Line != 1 || match.After != "padding-0" {
			t.Fatalf("old history excerpt = %+v", match)
		}
	}
	result, err = f.c.SearchHistory(bg, "old literal", true, nil)
	if err != nil || len(result.Matches) != 0 {
		t.Fatalf("case sensitive = %+v, %v", result, err)
	}
	result, err = f.c.SearchHistory(bg, "abcdefghijklmnopqrstuvwxyz-0123456789-END", true, []string{"second"})
	if err != nil || len(result.Matches) != 1 || result.Matches[0].SessionName != "first" {
		t.Fatalf("wrapped search = %+v, %v", result, err)
	}
	after := f.tmux(t, "list-panes", "-a", "-F", "#{pane_id}:#{pane_active}:#{pane_in_mode}")
	if before != after {
		t.Fatalf("search changed pane state: %q -> %q", before, after)
	}
	f.tmux(t, "link-window", "-s", "=first:0", "-t", "=second:1")
	result, err = f.c.SearchHistory(bg, "Old Literal", false, nil)
	if err != nil || len(result.Matches) != 2 {
		t.Fatalf("linked pane duplicated: %+v, %v", result, err)
	}
	result, err = f.c.SearchHistory(bg, "Old Literal", false, []string{"first"})
	if err != nil || len(result.Matches) != 1 || result.Matches[0].SessionName != "second" {
		t.Fatalf("excluded linked pane leaked: %+v, %v", result, err)
	}
	result, err = f.c.SearchHistory(bg, "padding", false, nil)
	if err != nil || len(result.Matches) != searchMaxMatches || !result.Partial {
		t.Fatalf("result cap = %+v, %v", result, err)
	}
	small := New(Options{Socket: f.sock, MaxOutput: 1024, Logger: quiet})
	result, err = small.SearchHistory(bg, "absent", false, nil)
	if err != nil || !result.Partial {
		t.Fatalf("capture cap = %+v, %v", result, err)
	}
	ctx, cancel := context.WithCancel(bg)
	cancel()
	_, err = f.c.SearchHistory(ctx, "Old Literal", false, nil)
	if err == nil {
		t.Fatal("canceled search succeeded")
	}
}

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
