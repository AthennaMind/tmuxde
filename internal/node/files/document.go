package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"syscall"
	"unicode/utf8"

	"tmuxde/internal/protocol"
)

var errDocumentText = errors.New("file is not UTF-8 text")

// Leave room for the path, revision and request envelope in a 1 MiB frame.
const editWireLimit = (1 << 20) - (16 << 10)

func fitsEditFrame(content string) bool {
	encoded, err := json.Marshal(content)
	return err == nil && len(encoded) <= editWireLimit
}

func revision(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// ReadDocument returns complete editable text. Binary and oversized files
// remain available through previews and downloads.
func (s *Service) ReadDocument(ctx context.Context, path string) (protocol.FileDocument, error) {
	var doc protocol.FileDocument
	if err := ctx.Err(); err != nil {
		return doc, err
	}

	_, real, err := s.guard.paths(path)
	if err != nil {
		return doc, fail(err)
	}
	f, _, err := openRegular(real)
	if err != nil {
		return doc, fail(err)
	}
	defer f.Close()

	data, err := io.ReadAll(io.LimitReader(f, s.writeLimit+1))
	if err != nil {
		return doc, fail(err)
	}
	if int64(len(data)) > s.writeLimit {
		return doc, &Error{msg: "File is too large to edit", err: errTooLarge}
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		return doc, &Error{msg: "Only UTF-8 text files can be edited", err: errDocumentText}
	}
	doc.Content = string(data)
	if !fitsEditFrame(doc.Content) {
		return protocol.FileDocument{}, &Error{msg: "File is too large to edit", err: errTooLarge}
	}
	doc.Revision = revision(doc.Content)
	doc.Writable = syscall.Access(real, accessWrite) == nil
	return doc, nil
}

// SaveDocument checks the last read revision before writing. Concurrent
// service saves are serialized. External writers do not share this mutex.
func (s *Service) SaveDocument(ctx context.Context, path, content, expected string) (protocol.FileDocument, bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var empty protocol.FileDocument
	if !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return empty, false, &Error{msg: "Only UTF-8 text files can be edited", err: errDocumentText}
	}
	if int64(len(content)) > s.writeLimit || !fitsEditFrame(content) {
		return empty, false, &Error{msg: "File is too large to edit", err: errTooLarge}
	}
	doc, err := s.ReadDocument(ctx, path)
	if err != nil {
		return empty, false, err
	}
	if doc.Revision != expected {
		return doc, true, nil
	}
	if _, err := s.write(ctx, path, content); err != nil {
		return empty, false, err
	}
	doc.Content = content
	doc.Revision = revision(content)
	return doc, false, nil
}
