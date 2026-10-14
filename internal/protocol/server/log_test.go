package server

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// TestLogRedactsPayload checks that messages with user content log their
// size, never the content. secret is the canary.
func TestLogRedactsPayload(t *testing.T) {
	const secret = "hunter2-canary-value"
	tests := []struct {
		msg  Message
		size string // key of the size attribute
	}{
		{&TerminalOutput{Type: "terminal:output", Data: secret}, "dataLength"},
		{&PaneCaptured{Type: "pane:captured", ID: "%1", Content: secret}, "contentLength"},
		{&DictationText{Type: "dictation:text", ID: "d1", Text: secret}, "textLength"},
		{&FileContent{Type: "file:content", Path: "/p", Content: secret}, "contentLength"},
	}
	for _, tt := range tests {
		t.Run(tt.msg.WireType(), func(t *testing.T) {
			var buf bytes.Buffer
			slog.New(slog.NewJSONHandler(&buf, nil)).Info("message", "msg", tt.msg)
			out := buf.String()
			if strings.Contains(out, secret) {
				t.Fatalf("payload in log: %s", out)
			}
			if !strings.Contains(out, `"type":"`+tt.msg.WireType()+`"`) {
				t.Fatalf("type missing from log: %s", out)
			}
			if !strings.Contains(out, `"`+tt.size+`":20`) {
				t.Fatalf("size %s missing from log: %s", tt.size, out)
			}
		})
	}
}
