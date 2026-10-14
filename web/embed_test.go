package web

import (
	"errors"
	"io/fs"
	"testing"
)

// TestDist checks that the embed is rooted at dist and that Present agrees
// with it. Both cases pass, with or without a web build in dist.
func TestDist(t *testing.T) {
	_, err := fs.Stat(Dist(), "index.html")
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("stat index.html: %v", err)
	}
	if got, want := Present(), err == nil; got != want {
		t.Fatalf("Present() = %v, want %v", got, want)
	}
	if !Present() {
		if _, err := fs.Stat(Dist(), ".gitkeep"); err != nil {
			t.Fatalf("no build and no .gitkeep in dist: %v", err)
		}
	}
	if _, err := fs.Stat(Dist(), "dist"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Dist is not rooted at dist: %v", err)
	}
}
