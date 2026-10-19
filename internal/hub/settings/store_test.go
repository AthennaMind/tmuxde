package settings

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// tempStore returns a store in a fresh dir below the test temp dir, so the
// store has to create it.
func tempStore(t *testing.T) *Store {
	t.Helper()
	return &Store{Dir: filepath.Join(t.TempDir(), "config")}
}

// wantOnly fails unless dir holds exactly the named entries. Temp files
// left by a write show up here.
func wantOnly(t *testing.T, dir string, names ...string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if strings.Join(got, ",") != strings.Join(names, ",") {
		t.Fatalf("dir holds %v, want %v", got, names)
	}
}

func TestLoadMissingFile(t *testing.T) {
	s := tempStore(t)
	for name, want := range map[string]string{NameSettings: "{}", NameKeybindings: "[]"} {
		body, etag, err := s.Load(name)
		if err != nil {
			t.Fatalf("Load(%s): %v", name, err)
		}
		if string(body) != want {
			t.Errorf("Load(%s) = %q, want %q", name, body, want)
		}
		if etag != ETag([]byte(want)) {
			t.Errorf("Load(%s) etag = %s, want the ETag of %s", name, etag, want)
		}
	}
	if _, err := os.Stat(s.Dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Load created the dir: %v", err)
	}
}

func TestETagFormat(t *testing.T) {
	got := ETag([]byte("{}"))
	want := `"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"`
	if got != want {
		t.Fatalf("ETag({}) = %s, want %s", got, want)
	}
}

func TestSaveRoundTrip(t *testing.T) {
	s := tempStore(t)
	_, empty, err := s.Load(NameSettings)
	if err != nil {
		t.Fatal(err)
	}
	// Raw bytes survive, white space and key order included.
	body := []byte("{\n  \"terminal.fontSize\": 14,\n\t\"appearance.theme\":\"light\"\n}\n")
	etag, err := s.Save(NameSettings, body, empty)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if etag != ETag(body) {
		t.Fatalf("Save etag = %s, want %s", etag, ETag(body))
	}
	got, gotTag, err := s.Load(NameSettings)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(body) || gotTag != etag {
		t.Fatalf("Load = %q %s, want %q %s", got, gotTag, body, etag)
	}
	onDisk, err := os.ReadFile(filepath.Join(s.Dir, "settings.json"))
	if err != nil || string(onDisk) != string(body) {
		t.Fatalf("settings.json = %q, %v", onDisk, err)
	}
	wantOnly(t, s.Dir, lockName, "settings.json")
}

func TestSaveETagFollowsContent(t *testing.T) {
	s := tempStore(t)
	first, err := s.Save(NameKeybindings, []byte(`[{"key":"ctrl+b","command":"sidebar.toggle"}]`), "*")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Save(NameKeybindings, []byte(`[{"key":"ctrl+e","command":"sidebar.files"}]`), first)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("ETag did not change with the content")
	}
	again, err := s.Save(NameKeybindings, []byte(`[{"key":"ctrl+b","command":"sidebar.toggle"}]`), second)
	if err != nil {
		t.Fatal(err)
	}
	if again != first {
		t.Fatalf("same content gave %s, want %s", again, first)
	}
}

func TestSaveStale(t *testing.T) {
	s := tempStore(t)
	_, empty, err := s.Load(NameSettings)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(NameSettings, []byte(`{"a.b":1}`), empty); err != nil {
		t.Fatal(err)
	}
	for _, ifMatch := range []string{empty, "", `"0000"`, "W/" + ETag([]byte(`{"a.b":1}`))} {
		if _, err := s.Save(NameSettings, []byte(`{"a.b":2}`), ifMatch); !errors.Is(err, ErrStale) {
			t.Errorf("Save with If-Match %q: %v, want ErrStale", ifMatch, err)
		}
	}
	body, _, err := s.Load(NameSettings)
	if err != nil || string(body) != `{"a.b":1}` {
		t.Fatalf("stale save changed the document: %q, %v", body, err)
	}
	wantOnly(t, s.Dir, lockName, "settings.json")
}

func TestSaveIfMatchList(t *testing.T) {
	s := tempStore(t)
	current := ETag([]byte("{}"))
	if _, err := s.Save(NameSettings, []byte(`{"a.b":1}`), `"0000", `+current); err != nil {
		t.Fatalf("Save with a list that holds the current ETag: %v", err)
	}
}

func TestSaveStar(t *testing.T) {
	s := tempStore(t)
	// Star matches a missing file and an existing one.
	if _, err := s.Save(NameSettings, []byte(`{"a.b":1}`), "*"); err != nil {
		t.Fatalf("Save * on a missing file: %v", err)
	}
	if _, err := s.Save(NameSettings, []byte(`{"a.b":2}`), " * "); err != nil {
		t.Fatalf("Save * on an existing file: %v", err)
	}
	body, _, err := s.Load(NameSettings)
	if err != nil || string(body) != `{"a.b":2}` {
		t.Fatalf("Load = %q, %v", body, err)
	}
}

func TestUnknownName(t *testing.T) {
	s := tempStore(t)
	for _, name := range []string{"", "machines", "settings.json", "../settings", "Settings"} {
		if _, _, err := s.Load(name); !errors.Is(err, ErrUnknownName) {
			t.Errorf("Load(%q): %v, want ErrUnknownName", name, err)
		}
		if _, err := s.Save(name, []byte("{}"), "*"); !errors.Is(err, ErrUnknownName) {
			t.Errorf("Save(%q): %v, want ErrUnknownName", name, err)
		}
	}
	if _, err := os.Stat(s.Dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("unknown names touched the dir: %v", err)
	}
}

func TestSaveRejectsBeforeWriting(t *testing.T) {
	s := tempStore(t)
	big := []byte(`{"a.b":"` + strings.Repeat("x", MaxBytes) + `"}`)
	if _, err := s.Save(NameSettings, big, "*"); !errors.Is(err, ErrTooLarge) {
		t.Errorf("Save of %d bytes: %v, want ErrTooLarge", len(big), err)
	}
	if _, err := s.Save(NameSettings, []byte(`{"bad":1}`), "*"); !errors.Is(err, ErrInvalid) {
		t.Errorf("Save of an invalid document: %v, want ErrInvalid", err)
	}
	// Validation runs before the If-Match compare.
	if _, err := s.Save(NameSettings, []byte(`[]`), `"stale"`); !errors.Is(err, ErrInvalid) {
		t.Errorf("Save of an invalid document with a stale If-Match: %v, want ErrInvalid", err)
	}
	if _, err := os.Stat(s.Dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("rejected saves touched the dir: %v", err)
	}
}

func TestSaveAtLimit(t *testing.T) {
	s := tempStore(t)
	prefix, suffix := `{"a.b":"`, `"}`
	body := []byte(prefix + strings.Repeat("x", MaxBytes-len(prefix)-len(suffix)) + suffix)
	if len(body) != MaxBytes {
		t.Fatalf("body has %d bytes", len(body))
	}
	if _, err := s.Save(NameSettings, body, "*"); err != nil {
		t.Fatalf("Save of exactly MaxBytes: %v", err)
	}
}

func TestSaveMode(t *testing.T) {
	s := tempStore(t)
	if _, err := s.Save(NameKeybindings, []byte(`[]`), "*"); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]os.FileMode{
		"":                 0700 | os.ModeDir,
		"keybindings.json": 0600,
		lockName:           0600,
	} {
		info, err := os.Stat(filepath.Join(s.Dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode() & (os.ModePerm | os.ModeDir); got != want {
			t.Errorf("%q has mode %v, want %v", name, got, want)
		}
	}
}

func TestSaveFailureLeavesNoTempFile(t *testing.T) {
	s := tempStore(t)
	if _, err := s.Save(NameSettings, []byte(`{"a.b":1}`), "*"); err != nil {
		t.Fatal(err)
	}
	// A directory in place of keybindings.json makes the rename fail after
	// the temp file is written.
	if err := os.Mkdir(filepath.Join(s.Dir, "keybindings.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Dir, "keybindings.json", "x"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(NameKeybindings, []byte(`[]`), "*"); err == nil {
		t.Fatal("Save over a directory succeeded")
	}
	wantOnly(t, s.Dir, lockName, "keybindings.json", "settings.json")
}

func TestLoadServesHandEdits(t *testing.T) {
	s := tempStore(t)
	if err := os.MkdirAll(s.Dir, 0700); err != nil {
		t.Fatal(err)
	}
	// A shell edit that no longer validates is served as it is, so the
	// browser can show the problem and the user can fix it.
	edited := []byte("{ \"Bad Key\": 1, }")
	if err := os.WriteFile(filepath.Join(s.Dir, "settings.json"), edited, 0600); err != nil {
		t.Fatal(err)
	}
	body, etag, err := s.Load(NameSettings)
	if err != nil || string(body) != string(edited) || etag != ETag(edited) {
		t.Fatalf("Load = %q %s %v", body, etag, err)
	}
	// Its ETag is the precondition for replacing it.
	if _, err := s.Save(NameSettings, []byte(`{"a.b":1}`), etag); err != nil {
		t.Fatalf("Save over the hand edit: %v", err)
	}
}

func TestEmptyDir(t *testing.T) {
	s := &Store{}
	if _, _, err := s.Load(NameSettings); err == nil {
		t.Error("Load without a dir succeeded")
	}
	if _, err := s.Save(NameSettings, []byte("{}"), "*"); err == nil {
		t.Error("Save without a dir succeeded")
	}
}

// writeBlocker puts a regular file at path, so a dir below it cannot exist.
func writeBlocker(path string) error {
	return os.WriteFile(path, []byte("x"), 0600)
}

// TestSaveConcurrentWriters races writers that all hold the ETag of the
// missing file. The lock spans compare and rename, so exactly one wins.
func TestSaveConcurrentWriters(t *testing.T) {
	s := tempStore(t)
	empty := ETag([]byte("{}"))
	const writers = 8
	errs := make(chan error, writers)
	for i := range writers {
		go func() {
			_, err := s.Save(NameSettings, []byte(fmt.Sprintf(`{"writer.n%d":true}`, i)), empty)
			errs <- err
		}()
	}
	won := 0
	for range writers {
		err := <-errs
		switch {
		case err == nil:
			won++
		case !errors.Is(err, ErrStale):
			t.Errorf("Save: %v, want nil or ErrStale", err)
		}
	}
	if won != 1 {
		t.Fatalf("%d writers won, want 1", won)
	}
	wantOnly(t, s.Dir, lockName, "settings.json")
}
