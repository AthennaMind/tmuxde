package settings

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"tmuxde/internal/protocol"
)

// TestDocumentContract reads the HTTP fixtures that
// ui/src/protocol/user-documents.test.ts parses with Zod. Go validation
// must accept the valid documents and reject every invalid entry, so the
// hub and the browser agree on what a document is.
func TestDocumentContract(t *testing.T) {
	dir, err := protocol.SourceDir()
	if err != nil {
		t.Fatal(err)
	}
	read := func(t *testing.T, file string) []byte {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(dir, "fixtures", "http", file))
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	for _, tt := range []struct {
		name, valid, invalid string
	}{
		{NameSettings, "user-settings.json", "user-settings.invalid.json"},
		{NameKeybindings, "user-keybindings.json", "user-keybindings.invalid.json"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			// The fixture file is the document, bytes as stored.
			if err := Validate(tt.name, read(t, tt.valid)); err != nil {
				t.Errorf("%s: %v", tt.valid, err)
			}
			var entries []map[string]json.RawMessage
			if err := json.Unmarshal(read(t, tt.invalid), &entries); err != nil {
				t.Fatal(err)
			}
			if len(entries) == 0 {
				t.Fatalf("%s has no entries", tt.invalid)
			}
			for i, entry := range entries {
				var reason string
				doc, hasDoc := entry["document"]
				if len(entry) != 2 || !hasDoc || json.Unmarshal(entry["reason"], &reason) != nil || reason == "" {
					t.Errorf("%s[%d] must be { reason, document }", tt.invalid, i)
					continue
				}
				if err := Validate(tt.name, doc); !errors.Is(err, ErrInvalid) {
					t.Errorf("%s[%d] %s: Validate = %v, Zod rejects it", tt.invalid, i, reason, err)
				}
				// The same text through the store is refused too.
				s := &Store{Dir: t.TempDir()}
				if _, err := s.Save(tt.name, bytes.Clone(doc), "*"); !errors.Is(err, ErrInvalid) {
					t.Errorf("%s[%d] %s: Save = %v, want ErrInvalid", tt.invalid, i, reason, err)
				}
			}
		})
	}
}
