package settings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

// MaxEntries caps the keys of settings and the entries of keybindings.
const MaxEntries = 512

// MaxChordLength caps a key or mac chord.
const MaxChordLength = 64

// Patterns shared with ui/src/protocol/user-documents.ts. A settings key
// is two or more dotted camelCase parts. A command id is the same with an
// optional leading -, which removes a default binding.
var (
	settingsKeyPattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$`)
	commandPattern     = regexp.MustCompile(`^-?[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$`)
)

// Scopes of a binding. Global is the default.
var scopes = []string{"global", "app", "terminal"}

// bindingFields are the only fields a binding entry may have.
var bindingFields = map[string]bool{"key": true, "mac": true, "command": true, "scope": true, "args": true}

// chordModifiers may each appear once before the key name of a chord.
var chordModifiers = map[string]bool{
	"ctrl": true, "shift": true, "alt": true, "cmd": true,
	"meta": true, "super": true, "win": true, "mod": true,
}

// chordKeys are the key names a chord may end with.
var chordKeys = func() map[string]bool {
	keys := map[string]bool{}
	for c := 'a'; c <= 'z'; c++ {
		keys[string(c)] = true
	}
	for c := '0'; c <= '9'; c++ {
		keys[string(c)] = true
	}
	for i := 1; i <= 12; i++ {
		keys[fmt.Sprintf("f%d", i)] = true
	}
	for _, k := range []string{
		"enter", "escape", "space", "tab", "backspace", "delete",
		"up", "down", "left", "right", "home", "end", "pageup", "pagedown",
		"-", "=", "[", "]", "`", "/", `\`, ",", ".", ";", "'",
	} {
		keys[k] = true
	}
	return keys
}()

// Validate checks body as the document name. It returns ErrUnknownName or
// an error that wraps ErrInvalid and names the first problem. Body must be
// UTF-8 and one JSON value.
func Validate(name string, body []byte) error {
	if !Known(name) {
		return ErrUnknownName
	}
	if !utf8.Valid(body) || !json.Valid(body) {
		return invalid("", "is not JSON")
	}
	if name == NameSettings {
		return validateSettings(body)
	}
	return validateKeybindings(body)
}

func invalid(path, reason string) error {
	if path == "" {
		return fmt.Errorf("%w: document %s", ErrInvalid, reason)
	}
	return fmt.Errorf("%w: %s %s", ErrInvalid, path, reason)
}

// validateSettings wants an object of at most MaxEntries dotted keys with
// any JSON values. Duplicate keys count once, as in JSON.parse.
func validateSettings(body []byte) error {
	var doc map[string]json.RawMessage
	if !isKind(body, '{') || json.Unmarshal(body, &doc) != nil {
		return invalid("", "must be an object")
	}
	if len(doc) > MaxEntries {
		return invalid("", fmt.Sprintf("must have at most %d keys", MaxEntries))
	}
	for key := range doc {
		if !settingsKeyPattern.MatchString(key) {
			return invalid(fmt.Sprintf("%q", key), "is not a dotted settings key")
		}
	}
	return nil
}

// validateKeybindings wants an array of at most MaxEntries binding
// entries.
func validateKeybindings(body []byte) error {
	var doc []json.RawMessage
	if !isKind(body, '[') || json.Unmarshal(body, &doc) != nil {
		return invalid("", "must be an array")
	}
	if len(doc) > MaxEntries {
		return invalid("", fmt.Sprintf("must have at most %d entries", MaxEntries))
	}
	for i, raw := range doc {
		if err := validateBinding(fmt.Sprintf("[%d]", i), raw); err != nil {
			return err
		}
	}
	return nil
}

// validateBinding checks one entry. Field names match exactly. Go would
// match struct fields without case, so the entry decodes into a map.
func validateBinding(path string, raw json.RawMessage) error {
	var entry map[string]json.RawMessage
	if !isKind(raw, '{') || json.Unmarshal(raw, &entry) != nil {
		return invalid(path, "must be an object")
	}
	for field := range entry {
		if !bindingFields[field] {
			return invalid(path+"."+field, "is not a binding field")
		}
	}
	_, hasKey := entry["key"]
	_, hasMac := entry["mac"]
	if !hasKey && !hasMac {
		return invalid(path, "needs key or mac")
	}
	for _, field := range []string{"key", "mac"} {
		raw, ok := entry[field]
		if !ok {
			continue
		}
		chord, ok := stringValue(raw)
		if !ok || !validChord(chord) {
			return invalid(path+"."+field, "is not a chord")
		}
	}
	command, ok := stringValue(entry["command"])
	if !ok || !commandPattern.MatchString(command) {
		return invalid(path+".command", "is not a command id")
	}
	if raw, ok := entry["scope"]; ok {
		scope, ok := stringValue(raw)
		if !ok || !slices.Contains(scopes, scope) {
			return invalid(path+".scope", "must be one of "+strings.Join(scopes, ", "))
		}
	}
	return nil
}

// validChord accepts lower case tokens joined by +: modifiers, each at
// most once, then one key name. Spaces and empty tokens never match.
func validChord(chord string) bool {
	if chord == "" || len(chord) > MaxChordLength {
		return false
	}
	tokens := strings.Split(chord, "+")
	seen := map[string]bool{}
	for _, token := range tokens[:len(tokens)-1] {
		if !chordModifiers[token] || seen[token] {
			return false
		}
		seen[token] = true
	}
	return chordKeys[tokens[len(tokens)-1]]
}

// stringValue decodes raw when it is a JSON string. null is not a string.
func stringValue(raw json.RawMessage) (string, bool) {
	if !isKind(raw, '"') {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

// isKind reports whether the JSON value in raw starts with first.
func isKind(raw []byte, first byte) bool {
	t := trimmed(raw)
	return len(t) > 0 && t[0] == first
}

// trimmed returns raw without JSON white space at either end.
func trimmed(raw []byte) []byte {
	return bytes.Trim(raw, " \t\r\n")
}
