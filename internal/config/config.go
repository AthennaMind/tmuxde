// Package config reads tmuxde settings from the environment. Names follow
// apps/relay/src/config.ts where the relay has the same setting.
package config

import (
	"errors"
	"fmt"
	"math"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// DefaultListen is the listen address when TMUXDE_LISTEN is unset.
const DefaultListen = "127.0.0.1:24200"

// exampleToken is the relay's well known default. Never accepted.
const exampleToken = "change-me-in-production"

// minTokenLength is the shortest AUTH_TOKEN accepted.
const minTokenLength = 16

// DefaultIdleTimeout is the idle timeout when IDLE_TIMEOUT_MINUTES is
// unset, as in the relay.
const DefaultIdleTimeout = 30 * time.Minute

// maxMachineName is the longest MACHINE_NAME accepted, in characters.
const maxMachineName = 64

// maxSocketPath is the longest unix socket path Linux takes. sun_path
// holds 108 bytes, the last one for the closing NUL. stt checks the same.
const maxSocketPath = 107

// Listen is where the HTTP server listens.
type Listen struct {
	// Network is "tcp" or "unix".
	Network string
	// Address is host:port for tcp and an absolute path for unix.
	Address string
}

func (l Listen) String() string {
	if l.Network == "unix" {
		return "unix:" + l.Address
	}
	return l.Address
}

// Config is the validated server configuration.
type Config struct {
	Listen Listen
	// DisableLocal permits a hub without tmux or filesystem access.
	DisableLocal bool
	// AuthToken is the shared secret browsers send in the auth message.
	AuthToken string
	// AllowedPaths are the roots that file and repository access may reach.
	AllowedPaths []string
	// TmuxSocket is passed to tmux -S. Empty means the tmux default.
	TmuxSocket string
	// TmuxDefaultShell is the command for new sessions and windows that
	// ask for none. It comes from TMUX_DEFAULT_SHELL and must be an
	// absolute path when set. Empty, the default, passes no command, so
	// tmux applies the user's default-command and default-shell options.
	// The relay always passed a shell, because its container had no
	// useful SHELL. On the host that bypassed the user's tmux config.
	TmuxDefaultShell string
	// TmuxLauncher says how a new session starts the tmux server when none
	// runs: "auto", "systemd-run" or "none". It comes from
	// TMUXDE_TMUX_LAUNCHER, default "auto". systemd-run starts the server
	// in a scope of its own, so a restart of the tmuxde unit does not kill
	// it. auto does that when tmuxde runs in a systemd unit. See
	// node/tmux.Launcher.
	TmuxLauncher string
	// MachineName is the name browsers show for the local node. It comes
	// from MACHINE_NAME. Empty means the hostname. Agents ignore it, as
	// they take their name from the machine record.
	MachineName string
	// CORSOrigins are the browser origins allowed to open the WebSocket.
	CORSOrigins []string
	// DevWebURL is the web dev server to proxy pages to. Nil when unset.
	DevWebURL *url.URL
	// STTSocket is the unix socket of the speech service. Empty means
	// dictation is off.
	STTSocket string
	// ConfigDir holds server state. Denied to file access.
	ConfigDir string
	// Home is the user home directory.
	Home string
	// IdleTimeout closes a browser connection with no inbound message for
	// this long. Zero disables it.
	IdleTimeout time.Duration
}

// Error is one invalid setting. It never contains the value of a secret.
type Error struct {
	Var    string
	Reason string
}

func (e *Error) Error() string {
	return e.Var + ": " + e.Reason
}

// settings are the variables Load reads, HOME aside, that lack the
// TMUXDE_ prefix. See IsSetting.
var settings = []string{
	"AUTH_TOKEN", "ALLOWED_PATHS", "CORS_ORIGINS", "STT_SOCKET",
	"TMUX_SOCKET", "TMUX_DEFAULT_SHELL", "IDLE_TIMEOUT_MINUTES",
	"MACHINE_NAME",
}

// IsSetting reports whether name is a tmuxde setting: any TMUXDE_
// variable, or one Load reads other than HOME. Commands that may start the
// tmux server drop them. tmux copies the environment of that command into
// its global environment, so every pane would get them. A tmuxde serve
// started from such a pane would then pick up the production socket and
// config folder.
func IsSetting(name string) bool {
	return strings.HasPrefix(name, "TMUXDE_") || slices.Contains(settings, name)
}

// FromEnv loads the configuration from the process environment.
func FromEnv() (Config, error) {
	return Load(os.LookupEnv)
}

// Load reads and validates every setting through lookup. It reports all
// invalid settings at once, joined.
func Load(lookup func(string) (string, bool)) (Config, error) {
	return load(lookup, false)
}

func load(lookup func(string) (string, bool), agent bool) (Config, error) {
	get := func(name string) string {
		v, _ := lookup(name)
		return strings.TrimSpace(v)
	}
	var cfg Config
	var errs []error
	fail := func(name, reason string) {
		errs = append(errs, &Error{name, reason})
	}

	if v := get("TMUXDE_LOCAL_NODE"); !agent && v != "" {
		if v != "true" && v != "false" {
			fail("TMUXDE_LOCAL_NODE", "must be true or false")
		}
		cfg.DisableLocal = v == "false"
	}

	cfg.Home = get("HOME")
	switch {
	case cfg.Home == "":
		fail("HOME", "is required")
	case !filepath.IsAbs(cfg.Home):
		fail("HOME", "must be an absolute path")
	default:
		cfg.Home = filepath.Clean(cfg.Home)
	}

	if !agent {
		listen := get("TMUXDE_LISTEN")
		if listen == "" {
			listen = DefaultListen
		}
		if l, err := parseListen(listen); err != nil {
			fail("TMUXDE_LISTEN", err.Error())
		} else {
			cfg.Listen = l
		}

		// Not trimmed: a token is compared byte for byte.
		token, _ := lookup("AUTH_TOKEN")
		switch {
		case token == "":
			fail("AUTH_TOKEN", "is required. Generate one with: openssl rand -hex 32")
		case token != strings.TrimSpace(token):
			fail("AUTH_TOKEN", "must not start or end with whitespace")
		case token == exampleToken:
			fail("AUTH_TOKEN", "must not be the example value")
		case len([]rune(token)) < minTokenLength:
			fail("AUTH_TOKEN", fmt.Sprintf("must be at least %d characters", minTokenLength))
		default:
			cfg.AuthToken = token
		}
	}

	if !cfg.DisableLocal {
		paths := splitList(get("ALLOWED_PATHS"))
		if len(paths) == 0 {
			fail("ALLOWED_PATHS", "is required, a comma separated list of absolute paths")
		}
		for _, p := range paths {
			if !filepath.IsAbs(p) {
				fail("ALLOWED_PATHS", fmt.Sprintf("%q is not an absolute path", p))
				continue
			}
			cfg.AllowedPaths = append(cfg.AllowedPaths, filepath.Clean(p))
		}

		if v := get("TMUX_SOCKET"); v != "" {
			if !filepath.IsAbs(v) {
				fail("TMUX_SOCKET", "must be an absolute path")
			} else {
				cfg.TmuxSocket = filepath.Clean(v)
			}
		}

		// Unset means tmux decides. SHELL is no fallback, as tmux reads it
		// itself when it picks default-shell. The value is not cleaned. tmux
		// runs it as a shell command, so it may carry arguments.
		if v := get("TMUX_DEFAULT_SHELL"); v != "" {
			if !filepath.IsAbs(v) {
				fail("TMUX_DEFAULT_SHELL", "must be an absolute path. Leave it unset to use the tmux default-command and default-shell")
			} else {
				cfg.TmuxDefaultShell = v
			}
		}

		cfg.TmuxLauncher = "auto"
		if v := get("TMUXDE_TMUX_LAUNCHER"); v != "" {
			switch v {
			case "auto", "systemd-run", "none":
				cfg.TmuxLauncher = v
			default:
				fail("TMUXDE_TMUX_LAUNCHER", fmt.Sprintf("must be auto, systemd-run or none, got %q", v))
			}
		}

		// Blank means the hostname. An agent never reads it.
		if v := get("MACHINE_NAME"); !agent && v != "" {
			if reason := checkMachineName(v); reason != "" {
				fail("MACHINE_NAME", reason)
			} else {
				cfg.MachineName = v
			}
		}
	}

	if !agent {
		origins := splitList(get("CORS_ORIGINS"))
		if len(origins) == 0 {
			fail("CORS_ORIGINS", "is required, a comma separated list of origins such as https://tmuxde.example")
		}
		for _, o := range origins {
			origin, err := parseOrigin(o)
			if err != nil {
				fail("CORS_ORIGINS", err.Error())
				continue
			}
			cfg.CORSOrigins = append(cfg.CORSOrigins, origin)
		}

		if v := get("TMUXDE_DEV_WEB_URL"); v != "" {
			u, err := parseDevWebURL(v)
			if err != nil {
				fail("TMUXDE_DEV_WEB_URL", err.Error())
			} else {
				cfg.DevWebURL = u
			}
		}

		if v := get("STT_SOCKET"); v != "" {
			switch p := filepath.Clean(v); {
			case !filepath.IsAbs(v):
				fail("STT_SOCKET", "must be an absolute path")
			case len(p) > maxSocketPath:
				fail("STT_SOCKET", fmt.Sprintf("must be at most %d bytes, got %d", maxSocketPath, len(p)))
			default:
				cfg.STTSocket = p
			}
		}

		cfg.IdleTimeout = DefaultIdleTimeout
		if v := get("IDLE_TIMEOUT_MINUTES"); v != "" {
			// The relay took any number. Whole minutes are enough here.
			n, err := strconv.Atoi(v)
			switch {
			case err != nil || n < 0:
				fail("IDLE_TIMEOUT_MINUTES", fmt.Sprintf("must be a whole number of minutes, 0 disables, got %q", v))
			case int64(n) > int64(math.MaxInt64/time.Minute):
				fail("IDLE_TIMEOUT_MINUTES", fmt.Sprintf("is too large, got %q", v))
			default:
				cfg.IdleTimeout = time.Duration(n) * time.Minute
			}
		}

	}
	cfg.ConfigDir = get("TMUXDE_CONFIG_DIR")
	switch {
	case cfg.ConfigDir == "" && cfg.Home != "" && filepath.IsAbs(cfg.Home):
		cfg.ConfigDir = filepath.Join(cfg.Home, ".config", "tmuxde")
	case cfg.ConfigDir == "":
		// HOME already failed. No second error for the same cause.
	case !filepath.IsAbs(cfg.ConfigDir):
		fail("TMUXDE_CONFIG_DIR", "must be an absolute path")
	default:
		cfg.ConfigDir = filepath.Clean(cfg.ConfigDir)
	}

	if len(errs) > 0 {
		return Config{}, errors.Join(errs...)
	}
	return cfg, nil
}

// checkMachineName returns why v is not a valid machine name, or "" when it
// is. v is already trimmed. Browsers show it as text, so control characters
// are refused.
func checkMachineName(v string) string {
	switch n := utf8.RuneCountInString(v); {
	case !utf8.ValidString(v):
		return "must be valid UTF-8"
	case n > maxMachineName:
		return fmt.Sprintf("must be at most %d characters, got %d", maxMachineName, n)
	case strings.ContainsFunc(v, unicode.IsControl):
		return "must not contain control characters"
	}
	return ""
}

// parseListen accepts host:port with an IP or localhost, or unix:/path.
// The server has no TLS and no client address filter yet. So the IP must be
// loopback or private, and every interface is refused.
func parseListen(v string) (Listen, error) {
	if path, ok := strings.CutPrefix(v, "unix:"); ok {
		if !filepath.IsAbs(path) {
			return Listen{}, errors.New("unix socket path must be absolute, as in unix:/run/tmuxde.sock")
		}
		return Listen{Network: "unix", Address: filepath.Clean(path)}, nil
	}
	host, port, err := net.SplitHostPort(v)
	if err != nil {
		return Listen{}, fmt.Errorf("must be host:port or unix:/path, got %q", v)
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return Listen{}, fmt.Errorf("port must be 1 to 65535, got %q", port)
	}
	if host == "" {
		return Listen{}, errors.New("host is required. Listening on every interface is not supported")
	}
	if host != "localhost" {
		ip, err := netip.ParseAddr(host)
		if err != nil {
			return Listen{}, fmt.Errorf("host must be an IP address or localhost, got %q", host)
		}
		ip = ip.Unmap()
		if ip.IsUnspecified() {
			return Listen{}, errors.New("listening on every interface is not supported")
		}
		if !ip.IsLoopback() && !ip.IsPrivate() {
			return Listen{}, fmt.Errorf("host must be loopback or a private address, got %q", host)
		}
	}
	return Listen{Network: "tcp", Address: net.JoinHostPort(host, port)}, nil
}

// parseOrigin accepts scheme://host[:port] as browsers send it in Origin.
func parseOrigin(v string) (string, error) {
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Hostname() == "" {
		return "", fmt.Errorf("%q is not an http or https origin", v)
	}
	if u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", fmt.Errorf("%q must be scheme://host[:port] only", v)
	}
	host := strings.ToLower(u.Host)
	// Browsers leave the default port out of Origin.
	if p := u.Port(); (u.Scheme == "http" && p == "80") || (u.Scheme == "https" && p == "443") {
		host = strings.ToLower(u.Hostname())
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
	}
	return u.Scheme + "://" + host, nil
}

// parseDevWebURL accepts an http or https base URL without query.
func parseDevWebURL(v string) (*url.URL, error) {
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, fmt.Errorf("%q must be an http:// URL such as http://127.0.0.1:24100", v)
	}
	if u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("%q must be scheme://host[:port] only", v)
	}
	return u, nil
}

func splitList(v string) []string {
	var out []string
	for item := range strings.SplitSeq(v, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}
