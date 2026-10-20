package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestValidateSettings(t *testing.T) {
	tests := []struct {
		name string
		body string
		ok   bool
	}{
		{"empty object", `{}`, true},
		{"white space around", " \n\t{}\r\n", true},
		{"dotted keys with any values", `{"appearance.theme":"dark","terminal.fontSize":14,"a.b.c":null,"x.y":[1,{"z":true}]}`, true},
		{"camel case parts", `{"touch.gesture.swipeToSwitchSessions":false,"a1.b2":1}`, true},
		{"escaped key", `{"\u0061ppearance.theme":"dark"}`, true},
		{"escape that makes a bad key", `{"a.b\u0020":1}`, false},
		{"duplicate keys", `{"a.b":1,"a.b":2}`, true},
		{"empty body", ``, false},
		{"not JSON", `{`, false},
		{"trailing data", `{} {}`, false},
		{"trailing comma", `{"a.b":1,}`, false},
		{"array", `[]`, false},
		{"string", `"a.b"`, false},
		{"null", `null`, false},
		{"number", `1`, false},
		{"one part", `{"theme":"dark"}`, false},
		{"empty key", `{"":1}`, false},
		{"upper case start", `{"Appearance.theme":1}`, false},
		{"upper case part", `{"appearance.Theme":1}`, false},
		{"digit start", `{"terminal.1x":1}`, false},
		{"dash", `{"terminal.font-size":1}`, false},
		{"empty part", `{"a..b":1}`, false},
		{"trailing dot", `{"a.":1}`, false},
		{"trailing newline", `{"a.b\n":1}`, false},
		{"non ASCII", `{"a.bä":1}`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			checkValidate(t, NameSettings, []byte(tt.body), tt.ok)
		})
	}
}

func TestValidateSettingsLimit(t *testing.T) {
	doc := func(n int) []byte {
		m := map[string]int{}
		for i := range n {
			m[fmt.Sprintf("test.key%d", i)] = i
		}
		b, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	checkValidate(t, NameSettings, doc(MaxEntries), true)
	checkValidate(t, NameSettings, doc(MaxEntries+1), false)
}

func TestValidateKeybindings(t *testing.T) {
	tests := []struct {
		name string
		body string
		ok   bool
	}{
		{"empty array", `[]`, true},
		{"key and command", `[{"key":"ctrl+b","command":"sidebar.toggle"}]`, true},
		{"mac only", `[{"mac":"cmd+b","command":"sidebar.toggle"}]`, true},
		{"key and mac", `[{"key":"ctrl+b","mac":"cmd+b","command":"sidebar.toggle"}]`, true},
		{"removal", `[{"key":"ctrl+b","command":"-sidebar.toggle"}]`, true},
		{"every scope", `[{"key":"a","command":"a.b","scope":"global"},{"key":"a","command":"a.b","scope":"app"},{"key":"a","command":"a.b","scope":"terminal"}]`, true},
		{"args of any kind", `[{"key":"a","command":"a.b","args":{"mode":"files"}},{"key":"a","command":"a.b","args":null},{"key":"a","command":"a.b","args":[1]}]`, true},
		{"not JSON", `[`, false},
		{"object", `{}`, false},
		{"null", `null`, false},
		{"string entry", `["ctrl+b"]`, false},
		{"null entry", `[null]`, false},
		{"no key or mac", `[{"command":"sidebar.toggle"}]`, false},
		{"no command", `[{"key":"ctrl+b"}]`, false},
		{"null command", `[{"key":"ctrl+b","command":null}]`, false},
		{"one part command", `[{"key":"ctrl+b","command":"lock"}]`, false},
		{"double dash command", `[{"key":"ctrl+b","command":"--a.b"}]`, false},
		{"null key", `[{"key":null,"command":"a.b"}]`, false},
		{"number key", `[{"key":1,"command":"a.b"}]`, false},
		{"bad mac beside good key", `[{"key":"ctrl+b","mac":"Cmd+B","command":"a.b"}]`, false},
		{"unknown scope", `[{"key":"ctrl+b","command":"a.b","scope":"editor"}]`, false},
		{"null scope", `[{"key":"ctrl+b","command":"a.b","scope":null}]`, false},
		{"unknown field", `[{"key":"ctrl+b","command":"a.b","when":"x"}]`, false},
		{"field in other case", `[{"Key":"ctrl+b","command":"a.b"}]`, false},
		{"bad second entry", `[{"key":"ctrl+b","command":"a.b"},{"key":"ctrl+b"}]`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			checkValidate(t, NameKeybindings, []byte(tt.body), tt.ok)
		})
	}
}

func TestValidateKeybindingsLimit(t *testing.T) {
	doc := func(n int) []byte {
		entries := make([]string, n)
		for i := range entries {
			entries[i] = `{"key":"ctrl+b","command":"sidebar.toggle"}`
		}
		return []byte("[" + strings.Join(entries, ",") + "]")
	}
	checkValidate(t, NameKeybindings, doc(MaxEntries), true)
	checkValidate(t, NameKeybindings, doc(MaxEntries+1), false)
}

func TestValidChord(t *testing.T) {
	valid := []string{
		"a", "z", "0", "9", "f1", "f12", "enter", "escape", "space", "tab",
		"backspace", "delete", "up", "down", "left", "right", "home", "end",
		"pageup", "pagedown", "-", "=", "[", "]", "`", "/", `\`, ",", ".", ";", "'",
		"shift+/", "ctrl+shift+space", "mod+k", "cmd+shift+=",
		"ctrl+shift+alt+cmd+meta+super+win+mod+pagedown",
	}
	for _, chord := range valid {
		if !validChord(chord) {
			t.Errorf("validChord(%q) = false, want true", chord)
		}
	}
	invalid := []string{
		"", "+", "ctrl+", "+a", "ctrl++", "ctrl++a", "ctrl+ctrl+a", "a+ctrl",
		"ctrl+shift", "ctrl", "Ctrl+a", "ctrl+A", "ctrl a", "ctrl+a ", " a",
		"f0", "f13", "plus", "hyper+a", "a+b", "ctrl+k ctrl+s", "ctrl\t+a",
		"ctrl+" + strings.Repeat("a", 64),
	}
	for _, chord := range invalid {
		if validChord(chord) {
			t.Errorf("validChord(%q) = true, want false", chord)
		}
	}
}

func TestValidateUnknownName(t *testing.T) {
	if err := Validate("machines", []byte("{}")); !errors.Is(err, ErrUnknownName) {
		t.Fatalf("Validate(machines): %v, want ErrUnknownName", err)
	}
}

func TestValidateRejectsInvalidUTF8(t *testing.T) {
	checkValidate(t, NameSettings, []byte("{\"a.b\":\"\xff\"}"), false)
}

func checkValidate(t *testing.T, name string, body []byte, ok bool) {
	t.Helper()
	err := Validate(name, body)
	if ok && err != nil {
		t.Fatalf("Validate(%s, %.80q): %v", name, body, err)
	}
	if !ok && !errors.Is(err, ErrInvalid) {
		t.Fatalf("Validate(%s, %.80q) = %v, want ErrInvalid", name, body, err)
	}
}
