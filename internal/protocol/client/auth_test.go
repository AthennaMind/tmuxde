package client

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"tmuxde/internal/protocol"
)

func TestDecodeAuthGroup(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    Message
		wantErr string
	}{
		{name: "auth", input: `{"type":"auth","token":"0123456789abcdef"}`, want: &Auth{Type: "auth", Token: "0123456789abcdef"}},
		{name: "auth empty token parses", input: `{"type":"auth","token":""}`, want: &Auth{Type: "auth"}},
		{name: "auth extra key", input: `{"type":"auth","token":"t","device":"x"}`, want: &Auth{Type: "auth", Token: "t"}},
		{name: "auth no token", input: `{"type":"auth"}`, wantErr: "token: required"},
		{name: "auth null token", input: `{"type":"auth","token":null}`, wantErr: "token: must not be null"},
		{name: "auth number token", input: `{"type":"auth","token":12}`, wantErr: "cannot unmarshal"},
		{name: "auth wrong case", input: `{"type":"auth","token":"a","Token":"b"}`, wantErr: "Token: unknown key"},
		{name: "ping", input: `{"type":"ping","timestamp":1791795723456}`, want: &Ping{Type: "ping", Timestamp: 1791795723456}},
		{name: "ping fraction", input: `{"type":"ping","timestamp":12.5}`, want: &Ping{Type: "ping", Timestamp: 12.5}},
		{name: "ping no timestamp", input: `{"type":"ping"}`, wantErr: "timestamp: required"},
		{name: "ping string timestamp", input: `{"type":"ping","timestamp":"1"}`, wantErr: "cannot unmarshal"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Decode([]byte(tt.input))
			if tt.wantErr != "" {
				if !errors.Is(err, protocol.ErrInvalid) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			switch want := tt.want.(type) {
			case *Auth:
				if g, ok := got.(*Auth); !ok || *g != *want {
					t.Fatalf("got %#v, want %#v", got, want)
				}
			case *Ping:
				if g, ok := got.(*Ping); !ok || *g != *want {
					t.Fatalf("got %#v, want %#v", got, want)
				}
			}
		})
	}
}

func TestAuthValidateType(t *testing.T) {
	if err := (&Auth{Type: "ping"}).Validate(); err == nil {
		t.Fatal("wrong type accepted")
	}
	if err := (&Ping{}).Validate(); err == nil {
		t.Fatal("empty type accepted")
	}
}

func TestAuthLogRedactsToken(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	logger.Info("message", "msg", &Auth{Type: "auth", Token: "secret-token-value"})
	if strings.Contains(buf.String(), "secret-token-value") {
		t.Fatalf("token in log: %s", buf.String())
	}
}
