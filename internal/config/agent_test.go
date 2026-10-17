package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHubOnlyConfiguration(t *testing.T) {
	env := base()
	env["TMUXDE_LOCAL_NODE"] = "false"
	delete(env, "ALLOWED_PATHS")
	env["TMUX_SOCKET"] = "ignored-local-setting"
	cfg, err := Load(lookup(env))
	if err != nil || !cfg.DisableLocal || len(cfg.AllowedPaths) != 0 {
		t.Fatalf("hub-only configuration: %+v, %v", cfg, err)
	}
	env["TMUXDE_LOCAL_NODE"] = "maybe"
	if _, err := Load(lookup(env)); err == nil {
		t.Fatal("invalid role setting accepted")
	}
}

func TestAgentConfiguration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent-token")
	if err := os.WriteFile(path, []byte(strings.Repeat("a", 64)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{
		"HOME":                    dir,
		"ALLOWED_PATHS":           dir,
		"TMUXDE_CONFIG_DIR":       dir,
		"TMUXDE_SERVER_URL":       "https://hub.example",
		"TMUXDE_AGENT_TOKEN_FILE": path,
	}
	cfg, err := LoadAgent(lookup(env))
	if err != nil || len(cfg.Token) != 64 || cfg.Node.AuthToken != "" {
		t.Fatalf("agent configuration failed: %v", err)
	}
	for _, value := range []string{
		"http://hub.example",
		"https://user:secret@hub.example",
		"https://hub.example/path",
		"https://hub.example?token=secret",
	} {
		env["TMUXDE_SERVER_URL"] = value
		if _, err := LoadAgent(lookup(env)); err == nil {
			t.Errorf("accepted server URL %q", value)
		}
	}
	env["TMUXDE_SERVER_URL"] = "https://hub.example"
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadAgent(lookup(env)); err == nil {
		t.Fatal("accepted readable token file")
	}
}

func TestAgentDevelopmentHTTP(t *testing.T) {
	dir := t.TempDir()
	for _, tt := range []struct {
		name, url, allowHTTP string
		wantError            bool
	}{
		{"https default", "https://hub.example", "", false},
		{"http default", "http://server-dev:24200", "", true},
		{"http disabled", "http://server-dev:24200", "false", true},
		{"http development", "http://server-dev:24200", "true", false},
		{"invalid flag", "https://hub.example", "yes", true},
		{"invalid scheme", "ftp://server-dev:24200", "true", true},
		{"credentials", "http://user:password@server-dev:24200", "true", true},
		{"path", "http://server-dev:24200/path", "true", true},
		{"query", "http://server-dev:24200?token=value", "true", true},
		{"fragment", "http://server-dev:24200#fragment", "true", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			env := map[string]string{
				"HOME":                  dir,
				"ALLOWED_PATHS":         dir,
				"TMUXDE_CONFIG_DIR":     dir,
				"TMUXDE_AGENT_TOKEN":    strings.Repeat("a", 64),
				"TMUXDE_SERVER_URL":     tt.url,
				"TMUXDE_DEV_ALLOW_HTTP": tt.allowHTTP,
			}
			_, err := LoadAgent(lookup(env))
			if (err != nil) != tt.wantError {
				t.Fatalf("LoadAgent error = %v, want error = %v", err, tt.wantError)
			}
		})
	}
}
