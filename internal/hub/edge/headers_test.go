package edge

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestContentSecurityPolicy(t *testing.T) {
	for _, socket := range []string{"", "ws://localhost:24200", "wss://dev.example"} {
		t.Run(socket, func(t *testing.T) {
			policy := parseCSP(contentSecurityPolicy(socket, false))
			connect := []string{"'self'"}
			if socket != "" {
				connect = append(connect, socket)
			}
			// Allow local previews and workers while blocking embedded plugins
			// and framing by other sites.
			for directive, want := range map[string][]string{
				"connect-src":     connect,
				"script-src":      {"'self'"},
				"script-src-attr": {"'none'"},
				"manifest-src":    {"'self'"},
				"font-src":        {"'self'", "data:", "blob:"},
				"media-src":       {"'self'", "blob:"},
				"frame-src":       {"'self'", "blob:"},
				"worker-src":      {"'self'", "blob:"},
				"object-src":      {"'none'"},
				"frame-ancestors": {"'none'"},
				"base-uri":        {"'none'"},
				"form-action":     {"'self'"},
			} {
				if got := policy[directive]; !slices.Equal(got, want) {
					t.Errorf("%s = %q, want %q", directive, got, want)
				}
			}
		})
	}
}

func TestDevelopmentCSPOnlyRelaxesInlineScripts(t *testing.T) {
	production := parseCSP(contentSecurityPolicy("ws://localhost:24200", false))
	development := parseCSP(contentSecurityPolicy("ws://localhost:24200", true))
	if got := development["script-src"]; !slices.Equal(got, []string{"'self'", "'unsafe-inline'"}) {
		t.Fatalf("development script-src = %q", got)
	}
	for directive, want := range production {
		if directive == "script-src" {
			continue
		}
		if got := development[directive]; !slices.Equal(got, want) {
			t.Errorf("development %s = %q, want %q", directive, got, want)
		}
	}
	for _, policy := range []string{contentSecurityPolicy("", false), contentSecurityPolicy("", true)} {
		if strings.Contains(policy, "'unsafe-eval'") {
			t.Fatal("policy allows eval")
		}
	}
}

func TestHTTPSHeadersOnPagesAssetsAndErrors(t *testing.T) {
	for _, target := range []string{"/", "/assets/app.js", "/sw.js", "/offline.html", "/missing"} {
		for _, transport := range []string{"http", "tls", "proxy"} {
			t.Run(transport+target, func(t *testing.T) {
				r := httptest.NewRequest(http.MethodGet, "http://tmuxde.test"+target, nil)
				switch transport {
				case "tls":
					r.TLS = &tls.ConnectionState{}
				case "proxy":
					r.Header.Set("X-Forwarded-Proto", "https")
				}
				rec := httptest.NewRecorder()
				Handler(Options{}).ServeHTTP(rec, r)
				socket := "ws://tmuxde.test"
				if transport != "http" {
					socket = "wss://tmuxde.test"
				}
				wantSecurityHeaders(t, rec.Header(), socket)
			})
		}
	}
}

func TestPermissionsPolicy(t *testing.T) {
	for _, permission := range []string{"microphone", "clipboard-read", "clipboard-write", "publickey-credentials-get", "publickey-credentials-create"} {
		if !strings.Contains(permissionsPolicy, permission+"=(self)") {
			t.Errorf("%s must remain limited to this origin", permission)
		}
	}
	for _, permission := range []string{"camera", "geolocation", "display-capture", "payment", "usb"} {
		if !strings.Contains(permissionsPolicy, permission+"=()") {
			t.Errorf("%s must remain disabled", permission)
		}
	}
}

// parseCSP maps each directive to its sources.
func parseCSP(policy string) map[string][]string {
	out := map[string][]string{}
	for _, part := range strings.Split(policy, ";") {
		fields := strings.Fields(part)
		if len(fields) > 0 {
			out[fields[0]] = fields[1:]
		}
	}
	return out
}

func TestSocketOrigin(t *testing.T) {
	tests := []struct {
		name  string
		host  string
		proto string
		tls   bool
		want  string
	}{
		{name: "plain http keeps the port", host: "tmuxde.test:24200", want: "ws://tmuxde.test:24200"},
		{name: "forwarded https", host: "dev.example", proto: "https", want: "wss://dev.example"},
		{name: "lower case like a URL origin", host: "Dev.Example", proto: "https", want: "wss://dev.example"},
		{name: "drops 443 for https", host: "dev.example:443", proto: "https", want: "wss://dev.example"},
		{name: "drops 80 for http", host: "dev.example:80", want: "ws://dev.example"},
		{name: "keeps 443 for http", host: "dev.example:443", want: "ws://dev.example:443"},
		{name: "drops an empty port", host: "dev.example:", want: "ws://dev.example"},
		{name: "ipv6 with port", host: "[::1]:24200", want: "ws://[::1]:24200"},
		{name: "ipv6 default port", host: "[::1]:80", want: "ws://[::1]"},
		{name: "first forwarded value wins", host: "dev.example", proto: "https, http", want: "wss://dev.example"},
		{name: "forwarded proto any case", host: "dev.example", proto: "HTTPS", want: "wss://dev.example"},
		{name: "forwarded http", host: "dev.example", proto: "http", want: "ws://dev.example"},
		{name: "direct tls", host: "dev.example", tls: true, want: "wss://dev.example"},
		{name: "no host", host: "", want: ""},
		{name: "host that would add a directive", host: "x; script-src *", want: ""},
		{name: "host with a quote", host: "x'", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			r.Host = tt.host
			if tt.proto != "" {
				r.Header.Set("X-Forwarded-Proto", tt.proto)
			}
			if tt.tls {
				r.TLS = &tls.ConnectionState{}
			}
			if got := socketOrigin(r); got != tt.want {
				t.Fatalf("socketOrigin = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestIsHubPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"/_relay", true},
		{"/_relay/x", true},
		{"/file", true},
		{"/file/x", true},
		{"/health", true},
		{"/health/", true},
		{"/_relayx", false},
		{"/files", false},
		{"/healthz", false},
		{"/login", false},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := isHubPath(tt.path); got != tt.want {
				t.Fatalf("isHubPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}
