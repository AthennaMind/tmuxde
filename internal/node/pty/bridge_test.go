package pty

import (
	"context"

	"log/slog"

	"strings"
	"testing"
)

var quiet = slog.New(slog.DiscardHandler)

func TestStartFailureIsSynchronous(t *testing.T) {
	_, err := Attach(context.Background(), "main", Options{Tmux: "/nonexistent/tmux", Logger: quiet})
	if err == nil {
		t.Fatal("Attach with a missing binary did not fail")
	}
	if _, err := Attach(context.Background(), "", Options{Logger: quiet}); err == nil {
		t.Fatal("Attach with an empty name did not fail")
	}
}

func TestAttachArgsAndEnv(t *testing.T) {
	got := attachArgs("s", Options{Socket: "/x/sock", ReadOnly: true})
	want := []string{"-u", "-S", "/x/sock", "attach-session", "-r", "-t", "=s"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("args %q, want %q", got, want)
	}
	if got := attachArgs("s", Options{}); strings.Join(got, " ") != "-u attach-session -t =s" {
		t.Fatalf("args %q", got)
	}
	got = attachArgs("s", Options{Socket: "/x/sock", NoStart: true})
	if strings.Join(got, " ") != "-u -N -S /x/sock attach-session -t =s" {
		t.Fatalf("args with NoStart %q", got)
	}
	env := attachEnv([]string{
		"TERM=dumb", "TMUX=/tmp/x,1,0", "TMUX_PANE=%1", "HOME=/h", "AUTH_TOKEN=x", "TMUXDE_X=1",
		"TMUXDE_LISTEN=unix:/run/http.sock", "TMUXDE_CONFIG_DIR=/c", "ALLOWED_PATHS=/h", "CORS_ORIGINS=https://x",
		"STT_SOCKET=/run/stt.sock", "TMUX_SOCKET=/s", "TMUX_DEFAULT_SHELL=/bin/sh", "IDLE_TIMEOUT_MINUTES=5",
		"PATH=/usr/bin", "LANG=C.UTF-8",
	})
	if strings.Join(env, " ") != "HOME=/h PATH=/usr/bin LANG=C.UTF-8 TERM=xterm-256color" {
		t.Fatalf("env %q", env)
	}
}
