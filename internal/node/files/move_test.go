package files

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"tmuxde/internal/node"
)

func TestMoveRefusesOccupiedDestination(t *testing.T) {
	for _, kind := range []string{"file", "directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			from := filepath.Join(f.sub, "source")
			to := filepath.Join(f.sub, "destination")
			if err := os.WriteFile(from, []byte("source"), 0o600); err != nil {
				t.Fatal(err)
			}
			var err error
			switch kind {
			case "file":
				err = os.WriteFile(to, []byte("destination"), 0o600)
			case "directory":
				err = os.Mkdir(to, 0o700)
			case "symlink":
				err = os.Symlink(filepath.Join(f.sub, "missing"), to)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := f.svc.Move(t.Context(), from, to); err == nil {
				t.Fatal("move replaced destination")
			}
			data, err := os.ReadFile(from)
			if err != nil || string(data) != "source" {
				t.Fatalf("source changed: %q, %v", data, err)
			}
			if kind == "file" {
				data, err = os.ReadFile(to)
				if err != nil || string(data) != "destination" {
					t.Fatalf("destination changed: %q, %v", data, err)
				}
			}
		})
	}
}

func TestMoveDirectoryAndGuards(t *testing.T) {
	f := newFixture(t)
	from := filepath.Join(f.sub, "folder")
	to := filepath.Join(f.sub, "moved")
	if err := os.Mkdir(from, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(from, "notes"), []byte("kept"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Move(t.Context(), from, filepath.Join(from, "child")); err == nil {
		t.Fatal("moved directory into itself")
	}
	if err := f.svc.Move(t.Context(), from, filepath.Join(f.ssh, "folder")); !errors.Is(err, node.ErrDenied) {
		t.Fatalf("guard: %v", err)
	}
	if err := f.svc.Move(t.Context(), from, to); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(to, "notes"))
	if err != nil || string(data) != "kept" {
		t.Fatalf("moved data: %q, %v", data, err)
	}
	if _, err := os.Stat(from); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old directory remains: %v", err)
	}
}

func TestMoveConcurrentDestination(t *testing.T) {
	f := newFixture(t)
	to := filepath.Join(f.sub, "destination")
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, name := range []string{"one", "two"} {
		from := filepath.Join(f.sub, name)
		if err := os.WriteFile(from, []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
		wg.Go(func() { results <- f.svc.Move(t.Context(), from, to) })
	}
	wg.Wait()
	first, second := <-results, <-results
	if (first == nil) == (second == nil) {
		t.Fatalf("expected one move: %v, %v", first, second)
	}
}
