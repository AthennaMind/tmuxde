package files

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func searchCandidates(count int) []searchMatch {
	rng := rand.New(rand.NewPCG(1, 2))
	matches := make([]searchMatch, count)
	for i := range matches {
		matches[i] = searchMatch{path: fmt.Sprintf("src/folder-%d/file-%d.go", rng.IntN(100), i), score: rng.IntN(5) * 100}
	}
	return matches
}

func TestKeepSearchMatch(t *testing.T) {
	candidates := searchCandidates(1000)
	for _, limit := range []int{0, 1, 7, searchResultLimit} {
		var got []searchMatch
		for i, candidate := range candidates {
			var overflow bool
			got, overflow = keepSearchMatch(got, candidate, limit)
			want := slices.Clone(candidates[:i+1])
			slices.SortFunc(want, compareSearchMatches)
			want = want[:min(len(want), limit)]
			if !slices.Equal(got, want) || overflow != (i >= limit) {
				t.Fatalf("limit %d, candidate %d: got %v, overflow %v, want %v", limit, i, got, overflow, want)
			}
		}
	}
}

// Measures ranking separately from filesystem traversal and path guards.
func BenchmarkSearchRanking(b *testing.B) {
	candidates := searchCandidates(searchEntryLimit)
	b.ReportAllocs()
	for b.Loop() {
		matches := make([]searchMatch, 0, searchResultLimit+1)
		for _, candidate := range candidates {
			matches, _ = keepSearchMatch(matches, candidate, searchResultLimit)
		}
		if len(matches) != searchResultLimit {
			b.Fatal("wrong result count")
		}
	}
}

func TestSearchGuardScopeAndRanking(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	for _, name := range []string{"readme.md", "src/README-helper.md", "docs/intro.md", "deep/closed/keyboard-toolbar.tsx", ".hidden", "node_modules/ignore/readme.md", ".git/readme.md", "private/readme.md", ".ssh/readme.md"} {
		full := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("no content search"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(outside, "readme-secret.md"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{"outside": outside, "readme-link.md": filepath.Join(outside, "readme-secret.md"), "loop": root, "readme-inside.md": "readme.md", "readme-denied.md": "private/readme.md"} {
		if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
	}
	guard, err := NewGuard([]string{root, outside}, root, filepath.Join(root, "private"))
	if err != nil {
		t.Fatal(err)
	}
	result, err := Search(context.Background(), guard, root, "README")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"readme.md", "readme-inside.md", "src/README-helper.md"}
	if !slices.Equal(result.Files, want) || result.Truncated {
		t.Fatalf("got %+v, want %v", result, want)
	}
	result, err = Search(context.Background(), guard, root, "kybrdtb")
	if err != nil || !slices.Equal(result.Files, []string{"deep/closed/keyboard-toolbar.tsx"}) {
		t.Fatalf("fuzzy result %+v: %v", result, err)
	}
	result, err = Search(context.Background(), guard, root, "closed toolbar")
	if err != nil || len(result.Files) != 1 {
		t.Fatalf("path terms %+v: %v", result, err)
	}
	result, err = Search(context.Background(), guard, root, ".hidden")
	if err != nil || len(result.Files) != 1 {
		t.Fatalf("hidden file %+v: %v", result, err)
	}
	if _, err = Search(context.Background(), guard, filepath.Join(root, "private"), "readme"); err == nil {
		t.Fatal("denied root accepted")
	}
}

func TestSearchBoundsAndCancellation(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"file-a", "file-b", "file-c"} {
		if err := os.WriteFile(filepath.Join(root, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	guard, err := NewGuard([]string{root}, root, "")
	if err != nil {
		t.Fatal(err)
	}
	result, err := search(context.Background(), guard, root, "file", 100, 2)
	if err != nil || len(result.Files) != 2 || !result.Truncated {
		t.Fatalf("result cap %+v: %v", result, err)
	}
	result, err = search(context.Background(), guard, root, "file", 1, 100)
	if err != nil || len(result.Files) != 1 || !result.Truncated {
		t.Fatalf("scan cap %+v: %v", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = Search(ctx, guard, root, "file"); err != context.Canceled {
		t.Fatalf("canceled: %v", err)
	}
}
