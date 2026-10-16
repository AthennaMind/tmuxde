package config

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

const token = "0123456789abcdef"

// base is a valid minimal environment. Cases change or remove keys.
func base() map[string]string {
	return map[string]string{
		"HOME":          "/home/dev",
		"AUTH_TOKEN":    token,
		"ALLOWED_PATHS": "/home/dev",
		"CORS_ORIGINS":  "https://tmuxde.example",
	}
}

func lookup(env map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) {
		v, ok := env[k]
		return v, ok
	}
}

func TestLoad(t *testing.T) {
	tests := []struct {
		name   string
		env    map[string]string // merged over base, "" value deletes
		check  func(t *testing.T, c Config)
		errVar []string // every Var expected in the error
		errMsg string
	}{
		{
			name: "defaults",
			check: func(t *testing.T, c Config) {
				// TmuxDefaultShell stays empty, so tmux picks the shell.
				want := Config{
					Listen:       Listen{Network: "tcp", Address: "127.0.0.1:24200"},
					AuthToken:    token,
					AllowedPaths: []string{"/home/dev"},
					CORSOrigins:  []string{"https://tmuxde.example"},
					ConfigDir:    "/home/dev/.config/tmuxde",
					Home:         "/home/dev",
					IdleTimeout:  30 * time.Minute,
					TmuxLauncher: "auto",
				}
				if !reflect.DeepEqual(c, want) {
					t.Fatalf("got  %+v\nwant %+v", c, want)
				}
			},
		},
		{
			name: "everything set",
			env: map[string]string{
				"TMUXDE_LISTEN":      "unix:/run/user/1000/tmuxde/http.sock",
				"ALLOWED_PATHS":      " /home/dev , /srv/data/ ,,",
				"TMUX_SOCKET":        "/tmp/tmux-1000/default",
				"TMUX_DEFAULT_SHELL": "/usr/bin/zsh",
				"CORS_ORIGINS":       "https://TmuxDE.example:443, http://127.0.0.1:24299",
				"TMUXDE_DEV_WEB_URL": "http://127.0.0.1:24100",
				"STT_SOCKET":         "/home/dev/.local/state/tmuxde/run/stt.sock",
				"TMUXDE_CONFIG_DIR":  "/etc/tmuxde/",
				"MACHINE_NAME":       " Build box ",
			},
			check: func(t *testing.T, c Config) {
				if c.Listen != (Listen{Network: "unix", Address: "/run/user/1000/tmuxde/http.sock"}) {
					t.Errorf("listen %+v", c.Listen)
				}
				if c.Listen.String() != "unix:/run/user/1000/tmuxde/http.sock" {
					t.Errorf("listen string %q", c.Listen.String())
				}
				if !reflect.DeepEqual(c.AllowedPaths, []string{"/home/dev", "/srv/data"}) {
					t.Errorf("allowed paths %q", c.AllowedPaths)
				}
				if c.TmuxSocket != "/tmp/tmux-1000/default" || c.TmuxDefaultShell != "/usr/bin/zsh" {
					t.Errorf("tmux %q %q", c.TmuxSocket, c.TmuxDefaultShell)
				}
				if !reflect.DeepEqual(c.CORSOrigins, []string{"https://tmuxde.example", "http://127.0.0.1:24299"}) {
					t.Errorf("origins %q", c.CORSOrigins)
				}
				if c.DevWebURL == nil || c.DevWebURL.String() != "http://127.0.0.1:24100" {
					t.Errorf("dev web url %v", c.DevWebURL)
				}
				if c.STTSocket != "/home/dev/.local/state/tmuxde/run/stt.sock" || c.ConfigDir != "/etc/tmuxde" {
					t.Errorf("stt %q config %q", c.STTSocket, c.ConfigDir)
				}
				if c.MachineName != "Build box" {
					t.Errorf("machine name %q", c.MachineName)
				}
			},
		},
		// SHELL is no fallback. tmux reads it itself.
		{
			name:  "SHELL ignored",
			env:   map[string]string{"SHELL": "/bin/bash"},
			check: func(t *testing.T, c Config) { want(t, c.TmuxDefaultShell, "") },
		},
		{
			name:  "blank shell is unset",
			env:   map[string]string{"TMUX_DEFAULT_SHELL": " \t "},
			check: func(t *testing.T, c Config) { want(t, c.TmuxDefaultShell, "") },
		},
		{
			name:  "shell trimmed",
			env:   map[string]string{"TMUX_DEFAULT_SHELL": " /bin/bash "},
			check: func(t *testing.T, c Config) { want(t, c.TmuxDefaultShell, "/bin/bash") },
		},
		{
			name:  "shell with arguments not cleaned",
			env:   map[string]string{"TMUX_DEFAULT_SHELL": "/bin/bash --rcfile /etc/../tmp/rc"},
			check: func(t *testing.T, c Config) { want(t, c.TmuxDefaultShell, "/bin/bash --rcfile /etc/../tmp/rc") },
		},
		{
			name:  "ipv6 loopback",
			env:   map[string]string{"TMUXDE_LISTEN": "[::1]:24200"},
			check: func(t *testing.T, c Config) { want(t, c.Listen.Address, "[::1]:24200") },
		},
		{
			name:  "localhost",
			env:   map[string]string{"TMUXDE_LISTEN": "localhost:8080"},
			check: func(t *testing.T, c Config) { want(t, c.Listen.Address, "localhost:8080") },
		},
		{
			name:  "private lan",
			env:   map[string]string{"TMUXDE_LISTEN": "192.168.1.10:24200"},
			check: func(t *testing.T, c Config) { want(t, c.Listen.Address, "192.168.1.10:24200") },
		},
		{
			name:  "docker bridge",
			env:   map[string]string{"TMUXDE_LISTEN": "172.17.0.1:24200"},
			check: func(t *testing.T, c Config) { want(t, c.Listen.Address, "172.17.0.1:24200") },
		},
		{
			name:  "ipv6 unique local",
			env:   map[string]string{"TMUXDE_LISTEN": "[fd00::1]:24200"},
			check: func(t *testing.T, c Config) { want(t, c.Listen.Address, "[fd00::1]:24200") },
		},
		{
			name:  "ipv6 origin default port",
			env:   map[string]string{"CORS_ORIGINS": "https://[::1]:443"},
			check: func(t *testing.T, c Config) { want(t, c.CORSOrigins[0], "https://[::1]") },
		},
		{
			name:  "idle timeout",
			env:   map[string]string{"IDLE_TIMEOUT_MINUTES": " 5 "},
			check: func(t *testing.T, c Config) { want(t, c.IdleTimeout, 5*time.Minute) },
		},
		{
			name:  "idle timeout off",
			env:   map[string]string{"IDLE_TIMEOUT_MINUTES": "0"},
			check: func(t *testing.T, c Config) { want(t, c.IdleTimeout, time.Duration(0)) },
		},
		{name: "idle timeout negative", env: map[string]string{"IDLE_TIMEOUT_MINUTES": "-1"}, errVar: []string{"IDLE_TIMEOUT_MINUTES"}, errMsg: "whole number of minutes"},
		{name: "idle timeout fraction", env: map[string]string{"IDLE_TIMEOUT_MINUTES": "1.5"}, errVar: []string{"IDLE_TIMEOUT_MINUTES"}, errMsg: "whole number of minutes"},
		{name: "idle timeout word", env: map[string]string{"IDLE_TIMEOUT_MINUTES": "never"}, errVar: []string{"IDLE_TIMEOUT_MINUTES"}, errMsg: "whole number of minutes"},
		{name: "idle timeout huge", env: map[string]string{"IDLE_TIMEOUT_MINUTES": "9999999999999"}, errVar: []string{"IDLE_TIMEOUT_MINUTES"}, errMsg: "too large"},
		{name: "no home", env: map[string]string{"HOME": ""}, errVar: []string{"HOME"}, errMsg: "is required"},
		{name: "relative home", env: map[string]string{"HOME": "home"}, errVar: []string{"HOME"}, errMsg: "absolute"},
		{name: "no token", env: map[string]string{"AUTH_TOKEN": ""}, errVar: []string{"AUTH_TOKEN"}, errMsg: "is required"},
		{name: "short token", env: map[string]string{"AUTH_TOKEN": "0123456789abcde"}, errVar: []string{"AUTH_TOKEN"}, errMsg: "at least 16"},
		{name: "example token", env: map[string]string{"AUTH_TOKEN": "change-me-in-production"}, errVar: []string{"AUTH_TOKEN"}, errMsg: "example"},
		{name: "token with newline", env: map[string]string{"AUTH_TOKEN": token + "\n"}, errVar: []string{"AUTH_TOKEN"}, errMsg: "whitespace"},
		{name: "no paths", env: map[string]string{"ALLOWED_PATHS": " , "}, errVar: []string{"ALLOWED_PATHS"}, errMsg: "is required"},
		{name: "relative path", env: map[string]string{"ALLOWED_PATHS": "/ok,src"}, errVar: []string{"ALLOWED_PATHS"}, errMsg: `"src" is not an absolute path`},
		{name: "no origins", env: map[string]string{"CORS_ORIGINS": ""}, errVar: []string{"CORS_ORIGINS"}, errMsg: "is required"},
		{name: "origin with path", env: map[string]string{"CORS_ORIGINS": "https://a.example/app"}, errVar: []string{"CORS_ORIGINS"}, errMsg: "scheme://host[:port] only"},
		{name: "origin not http", env: map[string]string{"CORS_ORIGINS": "ftp://a.example"}, errVar: []string{"CORS_ORIGINS"}, errMsg: "not an http or https origin"},
		{name: "origin bare host", env: map[string]string{"CORS_ORIGINS": "a.example"}, errVar: []string{"CORS_ORIGINS"}, errMsg: "not an http or https origin"},
		{name: "listen no port", env: map[string]string{"TMUXDE_LISTEN": "127.0.0.1"}, errVar: []string{"TMUXDE_LISTEN"}, errMsg: "host:port or unix:/path"},
		{name: "listen port zero", env: map[string]string{"TMUXDE_LISTEN": "127.0.0.1:0"}, errVar: []string{"TMUXDE_LISTEN"}, errMsg: "1 to 65535"},
		{name: "listen port name", env: map[string]string{"TMUXDE_LISTEN": "127.0.0.1:http"}, errVar: []string{"TMUXDE_LISTEN"}, errMsg: "1 to 65535"},
		{name: "listen all interfaces", env: map[string]string{"TMUXDE_LISTEN": ":24200"}, errVar: []string{"TMUXDE_LISTEN"}, errMsg: "every interface"},
		{name: "listen unspecified", env: map[string]string{"TMUXDE_LISTEN": "0.0.0.0:24200"}, errVar: []string{"TMUXDE_LISTEN"}, errMsg: "every interface"},
		{name: "listen hostname", env: map[string]string{"TMUXDE_LISTEN": "box.lan:24200"}, errVar: []string{"TMUXDE_LISTEN"}, errMsg: "IP address or localhost"},
		{name: "listen public", env: map[string]string{"TMUXDE_LISTEN": "8.8.8.8:24200"}, errVar: []string{"TMUXDE_LISTEN"}, errMsg: "loopback or a private address"},
		{name: "listen public v6", env: map[string]string{"TMUXDE_LISTEN": "[2001:4860:4860::8888]:24200"}, errVar: []string{"TMUXDE_LISTEN"}, errMsg: "loopback or a private address"},
		{name: "listen mapped public", env: map[string]string{"TMUXDE_LISTEN": "[::ffff:8.8.8.8]:24200"}, errVar: []string{"TMUXDE_LISTEN"}, errMsg: "loopback or a private address"},
		{name: "listen relative unix", env: map[string]string{"TMUXDE_LISTEN": "unix:run/http.sock"}, errVar: []string{"TMUXDE_LISTEN"}, errMsg: "absolute"},
		{name: "relative tmux socket", env: map[string]string{"TMUX_SOCKET": "sock"}, errVar: []string{"TMUX_SOCKET"}, errMsg: "absolute"},
		{name: "relative shell", env: map[string]string{"TMUX_DEFAULT_SHELL": "zsh"}, errVar: []string{"TMUX_DEFAULT_SHELL"}, errMsg: "absolute"},
		{name: "relative shell with absolute SHELL", env: map[string]string{"TMUX_DEFAULT_SHELL": "./zsh", "SHELL": "/bin/bash"}, errVar: []string{"TMUX_DEFAULT_SHELL"}, errMsg: "unset to use the tmux default-command"},
		{name: "dev url scheme", env: map[string]string{"TMUXDE_DEV_WEB_URL": "ws://127.0.0.1:24100"}, errVar: []string{"TMUXDE_DEV_WEB_URL"}, errMsg: "http://"},
		{name: "dev url path", env: map[string]string{"TMUXDE_DEV_WEB_URL": "http://127.0.0.1:24100/app?x=1"}, errVar: []string{"TMUXDE_DEV_WEB_URL"}, errMsg: "scheme://host[:port] only"},
		{
			name:  "launcher systemd-run",
			env:   map[string]string{"TMUXDE_TMUX_LAUNCHER": " systemd-run "},
			check: func(t *testing.T, c Config) { want(t, c.TmuxLauncher, "systemd-run") },
		},
		{
			name:  "launcher none",
			env:   map[string]string{"TMUXDE_TMUX_LAUNCHER": "none"},
			check: func(t *testing.T, c Config) { want(t, c.TmuxLauncher, "none") },
		},
		{
			name:  "blank launcher is auto",
			env:   map[string]string{"TMUXDE_TMUX_LAUNCHER": " "},
			check: func(t *testing.T, c Config) { want(t, c.TmuxLauncher, "auto") },
		},
		{name: "unknown launcher", env: map[string]string{"TMUXDE_TMUX_LAUNCHER": "systemd"}, errVar: []string{"TMUXDE_TMUX_LAUNCHER"}, errMsg: "auto, systemd-run or none"},
		{name: "relative stt socket", env: map[string]string{"STT_SOCKET": "stt.sock"}, errVar: []string{"STT_SOCKET"}, errMsg: "absolute"},
		{
			name:  "stt socket at the length limit",
			env:   map[string]string{"STT_SOCKET": "/" + strings.Repeat("s", 106)},
			check: func(t *testing.T, c Config) { want(t, len(c.STTSocket), 107) },
		},
		{name: "stt socket too long", env: map[string]string{"STT_SOCKET": "/" + strings.Repeat("s", 107)}, errVar: []string{"STT_SOCKET"}, errMsg: "at most 107 bytes, got 108"},
		{name: "relative config dir", env: map[string]string{"TMUXDE_CONFIG_DIR": "cfg"}, errVar: []string{"TMUXDE_CONFIG_DIR"}, errMsg: "absolute"},
		// Unset MACHINE_NAME leaves MachineName empty, see defaults.
		// serve then names the local node after the hostname.
		{
			name:  "machine name",
			env:   map[string]string{"MACHINE_NAME": "server-dev"},
			check: func(t *testing.T, c Config) { want(t, c.MachineName, "server-dev") },
		},
		{
			name:  "machine name trimmed",
			env:   map[string]string{"MACHINE_NAME": "\t Build box \n"},
			check: func(t *testing.T, c Config) { want(t, c.MachineName, "Build box") },
		},
		{
			name:  "blank machine name is unset",
			env:   map[string]string{"MACHINE_NAME": "   "},
			check: func(t *testing.T, c Config) { want(t, c.MachineName, "") },
		},
		{
			name:  "machine name at the length limit",
			env:   map[string]string{"MACHINE_NAME": strings.Repeat("m", 64)},
			check: func(t *testing.T, c Config) { want(t, c.MachineName, strings.Repeat("m", 64)) },
		},
		// 64 characters in 128 bytes. The limit counts characters.
		{
			name:  "machine name counts characters",
			env:   map[string]string{"MACHINE_NAME": strings.Repeat("ü", 64)},
			check: func(t *testing.T, c Config) { want(t, c.MachineName, strings.Repeat("ü", 64)) },
		},
		{
			name:  "machine name ignored without local node",
			env:   map[string]string{"TMUXDE_LOCAL_NODE": "false", "MACHINE_NAME": "bad\x00name"},
			check: func(t *testing.T, c Config) { want(t, c.MachineName, "") },
		},
		{name: "machine name too long", env: map[string]string{"MACHINE_NAME": strings.Repeat("m", 65)}, errVar: []string{"MACHINE_NAME"}, errMsg: "at most 64 characters, got 65"},
		{name: "machine name too long in characters", env: map[string]string{"MACHINE_NAME": strings.Repeat("ü", 65)}, errVar: []string{"MACHINE_NAME"}, errMsg: "at most 64 characters, got 65"},
		{name: "machine name with tab", env: map[string]string{"MACHINE_NAME": "build\tbox"}, errVar: []string{"MACHINE_NAME"}, errMsg: "control characters"},
		{name: "machine name with escape", env: map[string]string{"MACHINE_NAME": "box\x1b[31m"}, errVar: []string{"MACHINE_NAME"}, errMsg: "control characters"},
		{name: "machine name with newline", env: map[string]string{"MACHINE_NAME": "build\nbox"}, errVar: []string{"MACHINE_NAME"}, errMsg: "control characters"},
		{name: "machine name with c1 control", env: map[string]string{"MACHINE_NAME": "build\u0085box"}, errVar: []string{"MACHINE_NAME"}, errMsg: "control characters"},
		{name: "machine name with delete", env: map[string]string{"MACHINE_NAME": "box\x7f"}, errVar: []string{"MACHINE_NAME"}, errMsg: "control characters"},
		{name: "machine name not utf8", env: map[string]string{"MACHINE_NAME": "box\xff"}, errVar: []string{"MACHINE_NAME"}, errMsg: "valid UTF-8"},
		{
			name:   "all errors at once",
			env:    map[string]string{"HOME": "", "AUTH_TOKEN": "", "ALLOWED_PATHS": "", "CORS_ORIGINS": ""},
			errVar: []string{"HOME", "AUTH_TOKEN", "ALLOWED_PATHS", "CORS_ORIGINS"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := base()
			for k, v := range tt.env {
				if v == "" {
					delete(env, k)
				} else {
					env[k] = v
				}
			}
			cfg, err := Load(lookup(env))
			if len(tt.errVar) == 0 {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				tt.check(t, cfg)
				return
			}
			if err == nil {
				t.Fatalf("no error, config %+v", cfg)
			}
			for _, name := range tt.errVar {
				if !hasVar(err, name) {
					t.Errorf("error %q does not name %s", err, name)
				}
			}
			if !strings.Contains(err.Error(), tt.errMsg) {
				t.Errorf("error %q does not contain %q", err, tt.errMsg)
			}
		})
	}
}

// TestAgentIgnoresMachineName checks that an agent never reads
// MACHINE_NAME. Its name comes from the machine record.
func TestAgentIgnoresMachineName(t *testing.T) {
	env := base()
	env["MACHINE_NAME"] = "bad\x00name"
	cfg, err := load(lookup(env), true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want(t, cfg.MachineName, "")
}

func TestErrorsNeverShowToken(t *testing.T) {
	env := base()
	env["AUTH_TOKEN"] = "short-secret"
	_, err := Load(lookup(env))
	if err == nil || strings.Contains(err.Error(), "short-secret") {
		t.Fatalf("error %v", err)
	}
}

func hasVar(err error, name string) bool {
	var list []error
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		list = joined.Unwrap()
	} else {
		list = []error{err}
	}
	for _, e := range list {
		var ce *Error
		if errors.As(e, &ce) && ce.Var == name {
			return true
		}
	}
	return false
}

func want[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// TestIsSettingCoversLoad checks that every variable Load reads, HOME
// aside, counts as a setting. A new variable missing from the list would
// reach every pane of a tmux server that tmuxde starts.
func TestIsSettingCoversLoad(t *testing.T) {
	var read []string
	_, _ = Load(func(name string) (string, bool) {
		read = append(read, name)
		return "", false
	})
	if len(read) < 12 {
		t.Fatalf("Load read only %q", read)
	}
	for _, name := range read {
		if got := IsSetting(name); got != (name != "HOME") {
			t.Errorf("IsSetting(%q) = %v", name, got)
		}
	}
	for _, name := range []string{
		"HOME", "PATH", "SHELL", "USER", "LANG", "TERM", "TMUX", "TMUX_PANE", "TMUX_TMPDIR",
		"XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "TMUXDE", "tmuxde_listen",
	} {
		if IsSetting(name) {
			t.Errorf("IsSetting(%q) = true, want a shell variable", name)
		}
	}
	for _, name := range []string{"TMUXDE_LISTEN", "TMUXDE_TMUX_LAUNCHER", "TMUXDE_FUTURE", "AUTH_TOKEN", "STT_SOCKET", "MACHINE_NAME"} {
		if !IsSetting(name) {
			t.Errorf("IsSetting(%q) = false", name)
		}
	}
}
