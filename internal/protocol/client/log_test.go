package client

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
	content := secret
	tests := []struct {
		msg  Message
		size string // key of the size attribute, "" when there is none
	}{
		{&Auth{Type: "auth", Token: secret}, ""},
		{&TerminalInput{Type: "terminal:input", Data: secret}, "dataLength"},
		{&CommandSend{Type: "command:send", Command: secret}, "commandLength"},
		{&FileWrite{Type: "file:write", Path: "/p", Content: secret}, "contentLength"},
		{&FileCreate{Type: "file:create", Path: "/p", Content: &content}, "contentLength"},
		{&FileUpload{Type: "file:upload", Path: "/p", Content: secret}, "contentLength"},
		{&DictationAudio{Type: "dictation:audio", ID: "d1", PCM: secret}, "pcm"},
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
			if tt.size != "" && !strings.Contains(out, `"`+tt.size+`":20`) {
				t.Fatalf("size %s missing from log: %s", tt.size, out)
			}
		})
	}
}
