package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/config"
	"tmuxde/internal/hub/settings"
)

const wiringToken = "wiring-test-token-0123456789"

// TestUserDocumentsWiring runs the hub without a local node. A PUT on
// /user/settings lands in the config dir and reaches an authenticated
// browser socket as settings:changed. Paths below /user never reach the
// web app.
func TestUserDocumentsWiring(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{
		DisableLocal: true,
		AuthToken:    wiringToken,
		AllowedPaths: []string{dir},
		ConfigDir:    filepath.Join(dir, "config"),
		Home:         dir,
	}
	a, err := newApp(cfg, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	hs := httptest.NewServer(a.handler)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = a.relay.Shutdown(ctx)
		a.machines.Close()
		hs.Close()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(hs.URL, "http")+"/_relay?machine=hub", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"auth","token":"`+wiringToken+`"}`)); err != nil {
		t.Fatal(err)
	}
	readType := func(want string) map[string]string {
		t.Helper()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				t.Fatalf("waiting for %s: %v", want, err)
			}
			var msg map[string]any
			if err := json.Unmarshal(data, &msg); err != nil {
				t.Fatal(err)
			}
			if msg["type"] == want {
				out := map[string]string{}
				for k, v := range msg {
					if s, ok := v.(string); ok {
						out[k] = s
					}
				}
				return out
			}
		}
	}
	readType("auth:success")

	body := `{"appearance.theme":"light"}`
	req, err := http.NewRequest(http.MethodPut, hs.URL+settings.SettingsPath, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+wiringToken)
	req.Header.Set("If-Match", "*")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	etag := resp.Header.Get("ETag")
	if resp.StatusCode != http.StatusNoContent || etag != settings.ETag([]byte(body)) {
		t.Fatalf("PUT answered %d with ETag %q", resp.StatusCode, etag)
	}

	msg := readType("settings:changed")
	if msg["name"] != settings.NameSettings || msg["etag"] != etag {
		t.Fatalf("settings:changed = %v, want name settings and etag %s", msg, etag)
	}
	stored, err := os.ReadFile(filepath.Join(cfg.ConfigDir, "settings.json"))
	if err != nil || string(stored) != body {
		t.Fatalf("settings.json = %q, %v", stored, err)
	}

	for _, tt := range []struct {
		path   string
		status int
		body   string
	}{
		{settings.KeybindingsPath, http.StatusOK, "[]"},
		{"/user/other", http.StatusNotFound, "Not found"},
		{"/user", http.StatusNotFound, "Not found"},
	} {
		req, err := http.NewRequest(http.MethodGet, hs.URL+tt.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+wiringToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != tt.status || string(got) != tt.body {
			t.Errorf("GET %s = %d %q, want %d %q", tt.path, resp.StatusCode, got, tt.status, tt.body)
		}
	}
}
