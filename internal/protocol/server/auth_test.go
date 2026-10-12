package server

import (
	"errors"
	"strings"
	"testing"

	"tmuxde/internal/protocol"
)

func TestDecodeAuthGroupErrors(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr string
	}{
		{"success no version", `{"type":"auth:success"}`, "serverVersion: required"},
		{"success bad files", `{"type":"auth:success","serverVersion":"1","capabilities":{"readOnly":false,"files":"all","scope":"all"}}`, "capabilities.files: must be one of none, read, write"},
		{"success capabilities missing scope", `{"type":"auth:success","serverVersion":"1","capabilities":{"readOnly":false,"files":"read"}}`, "capabilities.scope: required"},
		{"success null capabilities", `{"type":"auth:success","serverVersion":"1","capabilities":null}`, "capabilities: must not be null"},
		{"success null features", `{"type":"auth:success","serverVersion":"1","features":null}`, "features: must not be null"},
		{"success null feature", `{"type":"auth:success","serverVersion":"1","features":["a",null]}`, "features[1]: must not be null"},
		{"failure no reason", `{"type":"auth:failure"}`, "reason: required"},
		{"pong no timestamp", `{"type":"pong"}`, "timestamp: required"},
		{"error no message", `{"type":"error","code":"X"}`, "message: required"},
		{"info no uptime", `{"type":"server:info","hostname":"h","platform":"linux"}`, "uptime: required"},
		{"info null path", `{"type":"server:info","hostname":"h","platform":"linux","uptime":1,"defaultPath":null}`, "defaultPath: must not be null"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Decode([]byte(tt.input))
			if !errors.Is(err, protocol.ErrInvalid) || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error %v, want %q", err, tt.wantErr)
			}
		})
	}
}

func TestEncodeAuthGroup(t *testing.T) {
	path := "/home/dev"
	tests := []struct {
		name string
		msg  Message
		want string
	}{
		{
			name: "success with empty features keeps the list",
			msg:  &AuthSuccess{Type: "auth:success", ServerVersion: "1.0.0", Features: []string{}},
			want: `{"type":"auth:success","serverVersion":"1.0.0","features":[]}`,
		},
		{
			name: "success without optional fields",
			msg:  &AuthSuccess{Type: "auth:success", ServerVersion: "1.0.0"},
			want: `{"type":"auth:success","serverVersion":"1.0.0"}`,
		},
		{
			name: "info with path",
			msg:  &ServerInfo{Type: "server:info", Hostname: "h", Platform: "linux", Uptime: 5, DefaultPath: &path},
			want: `{"type":"server:info","hostname":"h","platform":"linux","uptime":5,"defaultPath":"/home/dev"}`,
		},
		{
			name: "error",
			msg:  &Error{Type: "error", Code: "RATE_LIMITED", Message: "Too many messages"},
			want: `{"type":"error","code":"RATE_LIMITED","message":"Too many messages"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Encode(tt.msg)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tt.want {
				t.Fatalf("got  %s\nwant %s", got, tt.want)
			}
		})
	}
}

func TestEncodeRefusesInvalid(t *testing.T) {
	for _, msg := range []Message{
		&Pong{},
		&AuthFailure{Type: "auth:fail"},
		&AuthSuccess{Type: "auth:success", Capabilities: &Capabilities{Files: "everything"}},
	} {
		if _, err := Encode(msg); !errors.Is(err, protocol.ErrInvalid) {
			t.Errorf("%T encoded: %v", msg, err)
		}
	}
}
