package stt

import (
	"errors"
	"strings"
	"testing"
)

func env(vars map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		v, ok := vars[name]
		return v, ok
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{
		"STT_SOCKET":    "/run/tmuxde/stt/stt.sock",
		"STT_MODEL_DIR": "/models/parakeet",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		Socket:      "/run/tmuxde/stt/stt.sock",
		ModelDir:    "/models/parakeet",
		Threads:     4,
		MaxSessions: 4,
		MaxSeconds:  600,
	}
	if cfg != want {
		t.Fatalf("got %+v, want %+v", cfg, want)
	}
}

func TestLoadConfigReadsEverySetting(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{
		"STT_SOCKET":       "/tmp/s.sock",
		"STT_MODEL_DIR":    "/m",
		"STT_VAD_MODEL":    "/v/silero_vad.onnx",
		"STT_THREADS":      " 8 ",
		"STT_MAX_SESSIONS": "64",
		"STT_MAX_SECONDS":  "1e1",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{Socket: "/tmp/s.sock", ModelDir: "/m", VADModel: "/v/silero_vad.onnx", Threads: 8, MaxSessions: 64, MaxSeconds: 10}
	if cfg != want {
		t.Fatalf("got %+v, want %+v", cfg, want)
	}
}

func TestLoadConfigRefuses(t *testing.T) {
	long := "/" + strings.Repeat("a", maxSocketPath)
	tests := []struct {
		name   string
		vars   map[string]string
		errVar string
		reason string
	}{
		{"socket missing", map[string]string{"STT_MODEL_DIR": "/m"}, "STT_SOCKET", "is required"},
		{"socket relative", map[string]string{"STT_SOCKET": "stt.sock", "STT_MODEL_DIR": "/m"}, "STT_SOCKET", "must be an absolute path"},
		{"socket too long", map[string]string{"STT_SOCKET": long, "STT_MODEL_DIR": "/m"}, "STT_SOCKET", "must be at most 107 bytes"},
		{"model dir missing", map[string]string{"STT_SOCKET": "/s"}, "STT_MODEL_DIR", "is required"},
		{"model dir empty", map[string]string{"STT_SOCKET": "/s", "STT_MODEL_DIR": ""}, "STT_MODEL_DIR", "is required"},
		{"threads zero", map[string]string{"STT_SOCKET": "/s", "STT_MODEL_DIR": "/m", "STT_THREADS": "0"}, "STT_THREADS", "must be between 1 and 64"},
		{"threads too many", map[string]string{"STT_SOCKET": "/s", "STT_MODEL_DIR": "/m", "STT_THREADS": "65"}, "STT_THREADS", "must be between 1 and 64"},
		{"threads fraction", map[string]string{"STT_SOCKET": "/s", "STT_MODEL_DIR": "/m", "STT_THREADS": "2.5"}, "STT_THREADS", "must be an integer"},
		{"threads word", map[string]string{"STT_SOCKET": "/s", "STT_MODEL_DIR": "/m", "STT_THREADS": "four"}, "STT_THREADS", "must be a number"},
		{"sessions too many", map[string]string{"STT_SOCKET": "/s", "STT_MODEL_DIR": "/m", "STT_MAX_SESSIONS": "65"}, "STT_MAX_SESSIONS", "must be between 1 and 64"},
		{"seconds too few", map[string]string{"STT_SOCKET": "/s", "STT_MODEL_DIR": "/m", "STT_MAX_SECONDS": "9"}, "STT_MAX_SECONDS", "must be between 10 and 3600"},
		{"seconds too many", map[string]string{"STT_SOCKET": "/s", "STT_MODEL_DIR": "/m", "STT_MAX_SECONDS": "3601"}, "STT_MAX_SECONDS", "must be between 10 and 3600"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := LoadConfig(env(tt.vars))
			var ce *ConfigError
			if !errors.As(err, &ce) || ce.Var != tt.errVar || ce.Reason != tt.reason {
				t.Fatalf("err = %v, want %s: %s", err, tt.errVar, tt.reason)
			}
		})
	}
}

func TestLoadConfigReportsEveryError(t *testing.T) {
	_, err := LoadConfig(env(map[string]string{"STT_THREADS": "0"}))
	for _, name := range []string{"STT_SOCKET", "STT_MODEL_DIR", "STT_THREADS"} {
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Fatalf("err = %v, want it to name %s", err, name)
		}
	}
}
