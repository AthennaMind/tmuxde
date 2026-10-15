package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tmuxde/internal/stt"
	"tmuxde/internal/stt/sherpa"
)

func lookup(vars map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		v, ok := vars[name]
		return v, ok
	}
}

// shortDir is a fresh directory with a short path, for unix sockets.
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "stt-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func TestRun(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		code      int
		stdout    string
		stderrHas string
	}{
		{name: "version", args: []string{"version"}, code: 0, stdout: "dev\n"},
		{name: "help", args: []string{"help"}, code: 0, stdout: usage},
		{name: "unknown", args: []string{"listen"}, code: 2, stderrHas: `unknown command "listen"`},
		{name: "version argument", args: []string{"version", "x"}, code: 2, stderrHas: `unexpected argument "x"`},
		{name: "serve help", args: []string{"serve", "-h"}, code: 0, stderrHas: "STT_MAX_SECONDS"},
		{name: "health without socket", args: []string{"health"}, code: 1, stderrHas: "STT_SOCKET is not set"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := run(tt.args, lookup(nil), &stdout, &stderr)
			if code != tt.code {
				t.Fatalf("exit %d, want %d. stderr: %s", code, tt.code, stderr.String())
			}
			if tt.stdout != "" && stdout.String() != tt.stdout {
				t.Fatalf("stdout %q, want %q", stdout.String(), tt.stdout)
			}
			if !strings.Contains(stderr.String(), tt.stderrHas) {
				t.Fatalf("stderr %q, want it to contain %q", stderr.String(), tt.stderrHas)
			}
		})
	}
}

// logLines decodes JSON log lines.
func logLines(t *testing.T, out string) []map[string]any {
	t.Helper()
	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("not a JSON log line: %q", line)
		}
		lines = append(lines, m)
	}
	return lines
}

func TestServeRefusesBadConfig(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run(nil, lookup(map[string]string{"STT_SOCKET": "relative.sock"}), &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	vars := map[string]bool{}
	for _, line := range logLines(t, stdout.String()) {
		if line["msg"] != "Invalid configuration" {
			t.Fatalf("unexpected line %v", line)
		}
		vars[line["variable"].(string)] = true
	}
	if !vars["STT_SOCKET"] || !vars["STT_MODEL_DIR"] {
		t.Fatalf("logged %v, want STT_SOCKET and STT_MODEL_DIR", vars)
	}
}

func TestServeNamesMissingModelFiles(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"serve"}, lookup(map[string]string{
		"STT_SOCKET":    "/tmp/x.sock",
		"STT_MODEL_DIR": "/nonexistent",
	}), &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	lines := logLines(t, stdout.String())
	want := "model files missing in /nonexistent: encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt, run scripts/setup.sh --dictation"
	if len(lines) != 1 || lines[0]["msg"] != "Startup failed" || lines[0]["error"] != want {
		t.Fatalf("log %v", lines)
	}
}

func TestServeNamesMissingVADModel(t *testing.T) {
	dir := t.TempDir()
	for _, name := range stt.ModelFiles {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var stdout, stderr bytes.Buffer
	code := run(nil, lookup(map[string]string{
		"STT_SOCKET":    "/tmp/x.sock",
		"STT_MODEL_DIR": dir,
		"STT_VAD_MODEL": "/nonexistent/silero_vad.onnx",
	}), &stdout, &stderr)
	if code != 1 || !strings.Contains(stdout.String(), "VAD model missing at /nonexistent/silero_vad.onnx") {
		t.Fatalf("exit %d, log %s", code, stdout.String())
	}
}

func TestServeWithoutTheBindingNamesTheBuildTag(t *testing.T) {
	if sherpa.Built {
		t.Skip("binding compiled in")
	}
	dir := t.TempDir()
	for _, name := range stt.ModelFiles {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var stdout, stderr bytes.Buffer
	code := run(nil, lookup(map[string]string{"STT_SOCKET": "/tmp/x.sock", "STT_MODEL_DIR": dir}), &stdout, &stderr)
	if code != 1 || !strings.Contains(stdout.String(), "-tags sherpa") {
		t.Fatalf("exit %d, log %s", code, stdout.String())
	}
}

type fakeTranscriber struct{}

func (fakeTranscriber) Transcribe([]float32) (string, error) { return "", nil }

// startServe runs serve on a fresh socket until the returned cancel.
func startServe(t *testing.T) (string, context.CancelFunc, <-chan int, *bytes.Buffer) {
	t.Helper()
	path := filepath.Join(shortDir(t), "stt.sock")
	ctx, cancel := context.WithCancel(context.Background())
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	exit := make(chan int, 1)
	go func() {
		exit <- serve(ctx, stt.Config{Socket: path}, stt.ServerOptions{
			Transcriber: fakeTranscriber{},
			Model:       "test-model",
			MaxSessions: 1,
			Limits:      stt.SessionLimits{MaxSeconds: 10, Idle: time.Second},
			Logger:      logger,
		})
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if conn, err := net.Dial("unix", path); err == nil {
			conn.Close()
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("serve never listened")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return path, cancel, exit, &logs
}

func TestHealthCommand(t *testing.T) {
	path, cancel, exit, _ := startServe(t)
	var stdout, stderr bytes.Buffer
	if code := run([]string{"health"}, lookup(map[string]string{"STT_SOCKET": path}), &stdout, &stderr); code != 0 {
		t.Fatalf("health exit %d: %s", code, stderr.String())
	}
	cancel()
	if code := <-exit; code != 0 {
		t.Fatalf("serve exit %d", code)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("socket left behind: %v", err)
	}
	stderr.Reset()
	if code := run([]string{"health"}, lookup(map[string]string{"STT_SOCKET": path}), &stdout, &stderr); code != 1 {
		t.Fatalf("health of a stopped service exit %d", code)
	}
}

func TestHealthCommandNeedsStatus200(t *testing.T) {
	path := filepath.Join(shortDir(t), "stt.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()
	var stdout, stderr bytes.Buffer
	if code := run([]string{"health"}, lookup(map[string]string{"STT_SOCKET": path}), &stdout, &stderr); code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "status 503") {
		t.Fatalf("stderr %q", stderr.String())
	}
}

func TestServeLogsAndStops(t *testing.T) {
	path, cancel, exit, logs := startServe(t)
	cancel()
	select {
	case code := <-exit:
		if code != 0 {
			t.Fatalf("exit %d", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("serve did not stop within 3 s")
	}
	out := logs.String()
	for _, want := range []string{`"msg":"Speech service listening"`, `"socket":"` + path + `"`, `"msg":"Stopped"`} {
		if !strings.Contains(out, want) {
			t.Fatalf("log %s lacks %s", out, want)
		}
	}
}

func TestServeRefusesALiveSocket(t *testing.T) {
	path, cancel, exit, _ := startServe(t)
	defer func() {
		cancel()
		<-exit
	}()
	var logs bytes.Buffer
	code := serve(context.Background(), stt.Config{Socket: path}, stt.ServerOptions{
		Transcriber: fakeTranscriber{},
		MaxSessions: 1,
		Logger:      slog.New(slog.NewJSONHandler(&logs, nil)),
	})
	if code != 1 || !strings.Contains(logs.String(), "already listens") {
		t.Fatalf("exit %d, log %s", code, logs.String())
	}
}
