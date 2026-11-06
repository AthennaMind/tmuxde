package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestContentSearch(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	write := func(name, content string) {
		t.Helper()
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("src/main.go", "first\r\n\U0001F680 Needle needle\r\nlast needle\n")
	write("src/main_test.go", "Needle")
	write("private/secret.go", "Needle")
	write("binary.go", "Needle\x00")
	write("invalid.go", "Needle\xff")
	write("literal.go", "a.*b\naxxb")
	if err := os.WriteFile(filepath.Join(outside, "outside.go"), []byte("Needle"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "outside.go"), filepath.Join(root, "link.go")); err != nil {
		t.Fatal(err)
	}
	guard, err := NewGuard([]string{root, outside}, root, filepath.Join(root, "private"))
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{"src/main.go", "src/main.go", "src/main_test.go", "private/secret.go", "binary.go", "invalid.go", "literal.go", "link.go"}
	result, err := SearchContent(t.Context(), guard, root, paths, ContentSearchOptions{Query: "Needle", Include: "**/*.go", Exclude: "*_test.go"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Matches) != 2 || result.Truncated {
		t.Fatalf("result: %+v", result)
	}
	first := result.Matches[0]
	if first.Path != "src/main.go" || first.Line != 2 || first.Column != 4 || first.EndColumn != 10 || first.MatchStart != 3 || first.MatchEnd != 9 || strings.Contains(first.Preview, "\r") {
		t.Fatalf("match: %+v", first)
	}
	if err := result.Validate(); err != nil {
		t.Fatal(err)
	}
	result, err = SearchContent(t.Context(), guard, root, paths, ContentSearchOptions{Query: "Needle", CaseSensitive: true, Include: "src/**", Exclude: "**/*_test.go"})
	if err != nil || len(result.Matches) != 1 {
		t.Fatalf("case match: %+v %v", result, err)
	}
	result, err = SearchContent(t.Context(), guard, root, paths, ContentSearchOptions{Query: "a.*b"})
	if err != nil || len(result.Matches) != 1 || result.Matches[0].Line != 1 {
		t.Fatalf("literal: %+v %v", result, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := SearchContent(ctx, guard, root, paths, ContentSearchOptions{Query: "needle"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := SearchContent(t.Context(), guard, filepath.Join(root, "private"), paths, ContentSearchOptions{Query: "needle"}); err == nil {
		t.Fatal("denied root accepted")
	}
}

func TestContentSearchLimits(t *testing.T) {
	root := t.TempDir()
	guard, err := NewGuard([]string{root}, root, "")
	if err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"many": strings.Repeat("needle\n", 201), "large": strings.Repeat("x", contentFileLimit+1), "long": strings.Repeat("x", 2000) + "needle"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := SearchContent(t.Context(), guard, root, []string{"many"}, ContentSearchOptions{Query: "needle"})
	if err != nil || !result.Truncated || len(result.Matches) != contentResultLimit {
		t.Fatalf("limit: %+v %v", result, err)
	}
	result, err = SearchContent(t.Context(), guard, root, []string{"large"}, ContentSearchOptions{Query: "needle"})
	if err != nil || !result.Truncated || len(result.Matches) != 0 {
		t.Fatalf("large: %+v %v", result, err)
	}
	result, err = SearchContent(t.Context(), guard, root, []string{"../secret", "/etc/passwd", "long"}, ContentSearchOptions{Query: "needle"})
	if err != nil || !result.Truncated || len(result.Matches) != 1 {
		t.Fatalf("paths: %+v %v", result, err)
	}
	m := result.Matches[0]
	if m.Column != 2001 || len(m.Preview) > 600 || m.Preview[m.MatchStart:m.MatchEnd] != "needle" {
		t.Fatalf("preview: %+v", m)
	}
}

func TestContentPatternsAndUnicode(t *testing.T) {
	for _, test := range []struct {
		pattern, path string
		want          bool
	}{
		{"*.go", "src/main.go", true}, {"src/**", "src/deep/main.go", true},
		{"src/*.go", "src/deep/main.go", false}, {"**/*.go", "main.go", true},
		{"main.?o", "main.go", true}, {"a.ts, b.ts", "src/b.ts", true},
		{"file[1].go", "file[1].go", true}, {"src/**/main.go", "src/main.go", true},
	} {
		if got := contentMatches(contentPatterns(test.pattern), test.path); got != test.want {
			t.Errorf("%q %q: %v", test.pattern, test.path, got)
		}
	}
	line := strings.Repeat("\U0001F680", 100) + "needle" + strings.Repeat("\U0001F680", 100)
	m := contentMatch("a", 1, line, []int{400, 406})
	preview := utf16.Encode([]rune(m.Preview))
	if m.Column != 201 || string(utf16.Decode(preview[m.MatchStart:m.MatchEnd])) != "needle" {
		t.Fatalf("Unicode: %+v", m)
	}
	for _, query := range []string{"", "  ", "a\nb", "a\x00b", strings.Repeat("x", 257)} {
		if err := (ContentSearchOptions{Query: query}).Validate(); err == nil {
			t.Errorf("accepted query %q", query)
		}
	}
}
