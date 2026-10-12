package dictation

import (
	"bytes"
	"strings"
	"testing"
)

func TestParseSTT(t *testing.T) {
	// U+20000 is one rune and two UTF-16 code units.
	astral := "\U00020000"
	tests := []struct {
		name string
		in   string
		want sttMessage
		bad  bool
	}{
		{name: "ready", in: `{"type":"ready"}`, want: sttMessage{typ: "ready"}},
		{name: "ready with extra keys", in: `{"type":"ready","text":42,"x":null}`, want: sttMessage{typ: "ready"}},
		{name: "done", in: `{"type":"done"}`, want: sttMessage{typ: "done"}},
		{name: "text", in: `{"type":"text","text":"hi there"}`, want: sttMessage{typ: "text", text: "hi there"}},
		{name: "empty text", in: `{"type":"text","text":""}`, want: sttMessage{typ: "text"}},
		{name: "text at the limit", in: `{"type":"text","text":"` + strings.Repeat("a", 20_000) + `"}`, want: sttMessage{typ: "text", text: strings.Repeat("a", 20_000)}},
		{name: "astral text at the limit", in: `{"type":"text","text":"` + strings.Repeat(astral, 10_000) + `"}`, want: sttMessage{typ: "text", text: strings.Repeat(astral, 10_000)}},
		{name: "error", in: `{"type":"error","code":"IDLE","message":"No audio received"}`, want: sttMessage{typ: "error", code: "IDLE", message: "No audio received"}},

		{name: "not JSON", in: `nope`, bad: true},
		{name: "null", in: `null`, bad: true},
		{name: "array", in: `[{"type":"ready"}]`, bad: true},
		{name: "string", in: `"ready"`, bad: true},
		{name: "no type", in: `{"text":"hi"}`, bad: true},
		{name: "type not a string", in: `{"type":1}`, bad: true},
		{name: "unknown type", in: `{"type":"stop"}`, bad: true},
		{name: "type key in another case", in: `{"TYPE":"ready"}`, bad: true},
		{name: "text missing", in: `{"type":"text"}`, bad: true},
		{name: "text a number", in: `{"type":"text","text":42}`, bad: true},
		{name: "text null", in: `{"type":"text","text":null}`, bad: true},
		{name: "text over the limit", in: `{"type":"text","text":"` + strings.Repeat("a", 20_001) + `"}`, bad: true},
		{name: "astral text over the limit", in: `{"type":"text","text":"a` + strings.Repeat(astral, 10_000) + `"}`, bad: true},
		{name: "error without message", in: `{"type":"error","code":"IDLE"}`, bad: true},
		{name: "error with null code", in: `{"type":"error","code":null,"message":"x"}`, bad: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseSTT([]byte(tt.in), DefaultMaxText)
			if tt.bad {
				if err == nil {
					t.Fatalf("accepted %.60s as %+v", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("rejected: %v", err)
			}
			if got != tt.want {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestDecodePCM(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []byte
		bad  bool
	}{
		{name: "padded", in: "AQACAA==", want: []byte{1, 0, 2, 0}},
		{name: "unpadded", in: "AQACAA", want: []byte{1, 0, 2, 0}},
		{name: "short padding", in: "AQACAA=", want: []byte{1, 0, 2, 0}},
		{name: "one byte", in: "AQ==", want: []byte{1}},
		{name: "trailing single character dropped", in: "AAAAA", want: []byte{0, 0, 0}},
		{name: "lone character", in: "A", want: []byte{}},
		{name: "lone character padded", in: "A==", want: []byte{}},
		{name: "empty", in: "", want: []byte{}},
		{name: "loose trailing bits", in: "AB==", want: []byte{0}},
		{name: "outside the alphabet", in: "AQ-_", bad: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := DecodePCM(tt.in)
			if tt.bad {
				if err == nil {
					t.Fatalf("decoded %q to %v", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("error: %v", err)
			}
			if !bytes.Equal(got, tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}
