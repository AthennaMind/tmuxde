package edge

import (
	"crypto/tls"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// caddyCSP is the Content-Security-Policy line in .docker/Caddyfile with
// LOCAL_DOMAIN dev.example.
const caddyCSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://dev.example; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

// nextCSP is the header the Next dev server sent on 2026-10-12 for a
// request with X-Forwarded-Proto https, with its socket origin replaced by
// wss://dev.example.
const nextCSP = "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://dev.example; worker-src 'self' blob:; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self'; frame-src 'self';"

func TestContentSecurityPolicyMatchesCaddy(t *testing.T) {
	if got := contentSecurityPolicy("wss://dev.example"); got != caddyCSP {
		t.Fatalf("policy\n got %s\nwant %s", got, caddyCSP)
	}
	want := "connect-src 'self'; font-src"
	if got := contentSecurityPolicy(""); !strings.Contains(got, want) {
		t.Fatalf("policy without socket %q lacks %q", got, want)
	}
}

// TestContentSecurityPolicyCoversProxyTS checks that every source proxy.ts
// allows is still allowed, so moving to the Caddy policy broke nothing the
// pages loaded before.
func TestContentSecurityPolicyCoversProxyTS(t *testing.T) {
	got := parseCSP(contentSecurityPolicy("wss://dev.example"))
	for directive, sources := range parseCSP(nextCSP) {
		for _, src := range sources {
			if !slices.Contains(got[directive], src) {
				t.Errorf("%s lost %s", directive, src)
			}
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

func TestIsAsset(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		// Next paths are app paths since the move to Vite.
		{"/_next/static/chunks/main.js", false},
		{"/_next/image", false},
		{"/static/assets/x.js", false},
		// Vite build.
		{"/assets/app-abc123.js", true},
		{"/assets/index-abc123.css", true},
		{"/fonts/ibm-plex-mono-400.woff2", true},
		{"/fonts/LICENSE-NerdFonts.txt", true},
		{"/favicon.ico", true},
		{"/icon.svg", true},
		{"/icon-192.png", true},
		{"/icon-512.png", true},
		{"/icon-maskable-512.png", true},
		{"/apple-icon.png", true},
		{"/manifest.json", true},
		{"/offline.html", true},
		{"/sw.js", true},
		{"/dictation-worklet.js", true},
		{"/robots.txt", true},
		// Pages keep the headers.
		{"/", false},
		{"/index.html", false},
		{"/login", false},
		{"/s/abc", false},
		{"/s/assets/x.js", false},
		// Exact files match whole paths only.
		{"/icon.png", false},
		{"/icon-1024.png", false},
		{"/sw.js.map", false},
		{"/manifest.json/x", false},
		{"/robots.txt2", false},
		// Prefixes need the slash.
		{"/assets", false},
		{"/assetsx/app.js", false},
		{"/fonts", false},
		// No file extension, no asset. The static handler answers these
		// with index.html.
		{"/assets/", false},
		{"/fonts/", false},
		{"/fonts/x", false},
		{"/assets/x.d/app", false},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := isAsset(tt.path); got != tt.want {
				t.Fatalf("isAsset(%q) = %v, want %v", tt.path, got, tt.want)
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
