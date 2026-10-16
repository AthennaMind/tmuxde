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
