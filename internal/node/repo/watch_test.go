package repo

import (
	"testing"
)

func TestIgnoreSetMatch(t *testing.T) {
	s := newIgnoreSet()
	s.merge([]string{"build/", "a/b/", "x.log", ""})
	for rel, want := range map[string]bool{
		"build":       true,
		"build/x":     true,
		"build/x/y":   true,
		"builder":     false,
		"a":           false,
		"a/b":         true,
		"a/b/c":       true,
		"a/bc":        false,
		"x.log":       true,
		"y.log":       false,
		"src/x.log":   false,
		"src/build/x": false,
	} {
		if got := s.match(rel); got != want {
			t.Errorf("match(%q) = %v, want %v", rel, got, want)
		}
	}
}
