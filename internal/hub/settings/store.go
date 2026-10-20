// Package settings stores the user documents of the hub and serves them on
// GET and PUT /user/{name}. A document is one JSON file in the config dir:
// settings.json holds an object with dotted keys and keybindings.json holds
// an array of binding entries. Both hold overrides only.
//
// The hub keeps the bytes exactly as the browser sent them. It validates a
// document before it writes it and never reformats it, so the files stay
// editable from a shell. A file edited by hand is served as it is, even
// when it no longer validates.
//
// The ETag of a document is the quoted lower case hex SHA-256 of its bytes.
// A missing file reads as the empty value of its name, {} or [], with the
// ETag of that text. Writes need a matching If-Match, so two browsers that
// write at once see a conflict instead of a silent loss.
package settings

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Names of the two documents.
const (
	NameSettings    = "settings"
	NameKeybindings = "keybindings"
)

// MaxBytes caps a stored document at 256 KiB.
const MaxBytes = 256 << 10

// lockName is the lock file in Dir. Every write holds it.
const lockName = ".documents.lock"

// Sentinel errors of Load and Save. Validation errors wrap ErrInvalid and
// name the reason.
var (
	ErrUnknownName = errors.New("settings: unknown document name")
	ErrStale       = errors.New("settings: If-Match does not match the stored document")
	ErrInvalid     = errors.New("settings: invalid document")
	ErrTooLarge    = errors.New("settings: document too large")
)

// document describes one stored file.
type document struct {
	file  string
	empty string
}

var documents = map[string]document{
	NameSettings:    {file: "settings.json", empty: "{}"},
	NameKeybindings: {file: "keybindings.json", empty: "[]"},
}

// Known reports whether name is a document name.
func Known(name string) bool {
	_, ok := documents[name]
	return ok
}

// ETag returns the quoted lower case hex SHA-256 of body.
func ETag(body []byte) string {
	sum := sha256.Sum256(body)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

// Store reads and writes the documents in Dir, the config dir of the hub.
type Store struct {
	Dir string
}

// Load returns the stored bytes of name and their ETag. A missing file
// returns the empty value of name. A file edited by hand is returned as it
// is, even when it does not validate.
func (s *Store) Load(name string) ([]byte, string, error) {
	doc, ok := documents[name]
	if !ok {
		return nil, "", ErrUnknownName
	}
	if s.Dir == "" {
		return nil, "", errors.New("settings: no directory")
	}
	body, err := s.read(doc)
	if err != nil {
		return nil, "", err
	}
	return body, ETag(body), nil
}

// read returns the file of doc, or its empty value when there is none.
func (s *Store) read(doc document) ([]byte, error) {
	body, err := os.ReadFile(filepath.Join(s.Dir, doc.file))
	if errors.Is(err, os.ErrNotExist) {
		return []byte(doc.empty), nil
	}
	return body, err
}

// Save validates body and writes it as name when ifMatch matches the
// stored document. ifMatch is * for any state, or a list of ETags. Empty
// matches nothing. Save returns the new ETag. It returns ErrUnknownName,
// ErrTooLarge, an error that wraps ErrInvalid or ErrStale, in that order
// of checks, before it writes anything.
//
// The write holds an exclusive flock on .documents.lock in Dir across the
// compare and the rename. It goes to a temp file in Dir first, which is
// synced, closed and renamed over the document. CreateTemp makes the file
// with mode 0600, so the document never has wider permissions. A failed
// write removes its temp file and leaves the document as it was.
func (s *Store) Save(name string, body []byte, ifMatch string) (string, error) {
	doc, ok := documents[name]
	if !ok {
		return "", ErrUnknownName
	}
	if len(body) > MaxBytes {
		return "", ErrTooLarge
	}
	if err := Validate(name, body); err != nil {
		return "", err
	}
	if s.Dir == "" {
		return "", errors.New("settings: no directory")
	}
	if err := os.MkdirAll(s.Dir, 0700); err != nil {
		return "", err
	}
	lock, err := os.OpenFile(filepath.Join(s.Dir, lockName), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return "", err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return "", err
	}
	defer func() { _ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) }()

	current, err := s.read(doc)
	if err != nil {
		return "", err
	}
	if !matches(ifMatch, ETag(current)) {
		return "", ErrStale
	}
	if err := writeFile(s.Dir, doc.file, body); err != nil {
		return "", err
	}
	return ETag(body), nil
}

// matches applies If-Match with strong comparison. * matches any state,
// a missing file included. A weak tag never matches.
func matches(ifMatch, etag string) bool {
	ifMatch = strings.TrimSpace(ifMatch)
	if ifMatch == "*" {
		return true
	}
	for tag := range strings.SplitSeq(ifMatch, ",") {
		if strings.TrimSpace(tag) == etag {
			return true
		}
	}
	return false
}

// writeFile replaces dir/file with body through a synced temp file.
func writeFile(dir, file string, body []byte) error {
	f, err := os.CreateTemp(dir, "."+strings.TrimSuffix(file, ".json")+"-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	// After a rename the temp name is gone and this does nothing.
	defer os.Remove(tmp)
	_, err = f.Write(body)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp, filepath.Join(dir, file))
	}
	if err != nil {
		return fmt.Errorf("settings: write %s: %w", file, err)
	}
	return nil
}
