package repo

import (
	"reflect"

	"strings"
	"testing"

	"tmuxde/internal/protocol"
)

func num(v float64) *float64 { return &v }

func TestParseCommitTree(t *testing.T) {
	t.Run("keeps files whose patch was cut off", func(t *testing.T) {
		content := strings.Join([]string{
			":100644 100644 aaa bbb M",
			"one.txt",
			":000000 100644 000 ccc A",
			"two.txt",
			"1\t1\tone.txt",
			"3\t0\ttwo.txt",
			"",
			"diff --git a/one.txt b/one.txt\n@@ -1 +1 @@\n-a\n+b\n",
		}, "\x00")
		want := []protocol.RepoCommitFile{
			{Path: "one.txt", Status: "M", Additions: num(1), Deletions: num(1), Binary: false, Patch: "diff --git a/one.txt b/one.txt\n@@ -1 +1 @@\n-a\n+b"},
			{Path: "two.txt", Status: "A", Additions: num(3), Deletions: num(0), Binary: false, Patch: ""},
		}
		if got := parseCommitTree(content); !reflect.DeepEqual(got, want) {
			t.Fatalf("parseCommitTree = %+v, want %+v", got, want)
		}
	})

	t.Run("reads rename counts printed as separate path records", func(t *testing.T) {
		content := strings.Join([]string{
			":100644 100644 aaa bbb R090",
			"old.txt",
			"new.txt",
			"2\t1\t",
			"old.txt",
			"new.txt",
			"",
			"diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n",
		}, "\x00")
		got := parseCommitTree(content)
		if len(got) != 1 {
			t.Fatalf("parseCommitTree = %+v, want one file", got)
		}
		f := got[0]
		if f.Path != "new.txt" || deref(f.OriginalPath) != "old.txt" || f.Status != "R" || val(f.Additions) != 2 || val(f.Deletions) != 1 {
			t.Fatalf("file = %+v", f)
		}
	})
}

// val is *p, or the zero value for nil.
func val[T any](p *T) T {
	if p == nil {
		var zero T
		return zero
	}
	return *p
}
