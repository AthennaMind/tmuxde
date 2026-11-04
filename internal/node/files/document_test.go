package files

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestDocumentSaveRejectsStaleRevision(t *testing.T) {
	f := newFixture(t)
	path := filepath.Join(f.user, "notes.txt")
	if err := os.WriteFile(path, []byte("first\r\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	doc, err := f.svc.ReadDocument(t.Context(), path)
	if err != nil || doc.Content != "first\r\n" || len(doc.Revision) != 64 {
		t.Fatalf("read = %+v, %v", doc, err)
	}
	if err := os.WriteFile(path, []byte("external\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	current, conflict, err := f.svc.SaveDocument(t.Context(), path, "mine\n", doc.Revision)
	if err != nil || !conflict || current.Content != "external\n" {
		t.Fatalf("stale save = %+v, %v, %v", current, conflict, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "external\n" {
		t.Fatalf("conflict overwrote disk: %q, %v", data, err)
	}
	saved, conflict, err := f.svc.SaveDocument(t.Context(), path, "mine\n", current.Revision)
	if err != nil || conflict || saved.Revision != revision("mine\n") {
		t.Fatalf("save = %+v, %v, %v", saved, conflict, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("mode changed: %v, %v", info, err)
	}
}

func TestDocumentConcurrentSave(t *testing.T) {
	f := newFixture(t)
	path := filepath.Join(f.user, "notes.txt")
	if err := os.WriteFile(path, []byte("base"), 0o600); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	conflicts := make(chan bool, 2)
	for _, text := range []string{"one", "two"} {
		wg.Go(func() {
			_, conflict, err := f.svc.SaveDocument(t.Context(), path, text, revision("base"))
			if err != nil {
				t.Error(err)
			}
			conflicts <- conflict
		})
	}
	wg.Wait()
	if first, second := <-conflicts, <-conflicts; first == second {
		t.Fatalf("exactly one save should conflict: %v, %v", first, second)
	}
}

func TestDocumentLimitsAndGuards(t *testing.T) {
	f := newFixture(t)
	svc := New(f.guard, Options{WriteLimit: 8})
	for _, content := range []string{"ninebytes", "nul\x00", "\xff"} {
		path := filepath.Join(f.user, "bad.txt")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.ReadDocument(t.Context(), path); err == nil {
			t.Fatalf("read accepted %q", content)
		}
	}
	for _, path := range []string{filepath.Join(f.outside, "secret.txt"), filepath.Join(f.ssh, "id_rsa")} {
		if _, err := svc.ReadDocument(t.Context(), path); err == nil {
			t.Fatalf("read allowed %s", path)
		}
		if _, _, err := svc.SaveDocument(t.Context(), path, "mine", strings.Repeat("a", 64)); err == nil {
			t.Fatalf("save allowed %s", path)
		}
	}
}

func TestDocumentEncodedLimit(t *testing.T) {
	f := newFixture(t)
	path := filepath.Join(f.user, "escaped.txt")
	content := strings.Repeat("\t", 600_000)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.ReadDocument(t.Context(), path); err == nil {
		t.Fatal("accepted content exceeding frame limit after JSON encoding")
	}
	if err := os.WriteFile(path, []byte("base"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.svc.SaveDocument(t.Context(), path, content, revision("base")); err == nil {
		t.Fatal("accepted oversized save")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "base" {
		t.Fatalf("rejected save changed disk: %q, %v", data, err)
	}
}

func TestDocumentDeletedFileAndEmptySave(t *testing.T) {
	f := newFixture(t)
	path := filepath.Join(f.user, "notes.txt")
	if err := os.WriteFile(path, []byte("base"), 0o600); err != nil {
		t.Fatal(err)
	}
	doc, conflict, err := f.svc.SaveDocument(t.Context(), path, "", revision("base"))
	if err != nil || conflict || doc.Content != "" || doc.Revision != revision("") {
		t.Fatalf("empty save = %+v, %v, %v", doc, conflict, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.svc.SaveDocument(t.Context(), path, "draft", doc.Revision); err == nil {
		t.Fatal("save recreated deleted file")
	}
}
