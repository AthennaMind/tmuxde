package files

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

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
