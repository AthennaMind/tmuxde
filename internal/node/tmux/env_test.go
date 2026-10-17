package tmux

import (
	"slices"
	"testing"
)

// TestCommandEnvDropsUnitVariables checks the environment a tmux server
// started by tmuxde gets: none of the unit's variables, none of the
// tmuxde settings from the env file, everything a shell needs.
func TestCommandEnvDropsUnitVariables(t *testing.T) {
	keep := []string{
		"PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin", "HOME=/home/u", "SHELL=/bin/bash",
		"LANG=en_US.UTF-8", "TERM=xterm-256color", "XDG_RUNTIME_DIR=/run/user/1000",
		"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", "USER=u", "LOGNAME=u",
		"TMUX_TMPDIR=/run/user/1000",
	}
	// Settings must not leak into pane processes.
	settings := []string{
		"AUTH_TOKEN", "ALLOWED_PATHS", "CORS_ORIGINS", "STT_SOCKET", "TMUX_SOCKET",
		"TMUX_DEFAULT_SHELL", "IDLE_TIMEOUT_MINUTES", "TMUXDE_LISTEN", "TMUXDE_CONFIG_DIR",
		"TMUXDE_TMUX_LAUNCHER", "TMUXDE_DEV_WEB_URL",
	}
	var in []string
	for _, k := range append(slices.Clone(unitEnv), settings...) {
		in = append(in, k+"=x")
	}
	in = append(in, keep...)
	if got := commandEnv(in); !slices.Equal(got, keep) {
		t.Fatalf("commandEnv = %q, want %q", got, keep)
	}
}
