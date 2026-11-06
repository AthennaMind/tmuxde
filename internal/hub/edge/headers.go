package edge

import (
	"net"
	"net/http"
	"strings"
)

// securityHeaders are the header names the edge owns. The dev proxy drops
// upstream copies so edge values are the only ones.
var securityHeaders = []string{
	"Content-Security-Policy",
	"Permissions-Policy",
	"X-Frame-Options",
	"X-Content-Type-Options",
	"Referrer-Policy",
	"Strict-Transport-Security",
	"Cross-Origin-Opener-Policy",
	"Cross-Origin-Resource-Policy",
	"Origin-Agent-Cluster",
	"X-Robots-Tag",
}

const permissionsPolicy = "microphone=(self), clipboard-read=(self), clipboard-write=(self), " +
	"publickey-credentials-get=(self), publickey-credentials-create=(self), fullscreen=(self), " +
	"camera=(), geolocation=(), display-capture=(), accelerometer=(), gyroscope=(), " +
	"magnetometer=(), midi=(), payment=(), usb=()"

// setSecurityHeaders protects all responses, including assets and errors.
func setSecurityHeaders(h http.Header, r *http.Request, development bool) {
	h.Set("Content-Security-Policy", contentSecurityPolicy(socketOrigin(r), development))
	// Microphone for dictation, this origin only. Nothing records until
	// the user presses the mic and the browser asks.
	h.Set("Permissions-Policy", permissionsPolicy)
	h.Set("X-Frame-Options", "DENY")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Origin-Agent-Cluster", "?1")
	h.Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	if requestScheme(r) == "https" {
		// Scope to this host. Subdomains may serve unrelated applications.
		h.Set("Strict-Transport-Security", "max-age=31536000")
	} else {
		h.Del("Strict-Transport-Security")
	}
}

// contentSecurityPolicy allows local assets and the page's WebSocket origin.
// Blob sources support file previews, media and workers. An empty socket
// leaves connect-src limited to self.
func contentSecurityPolicy(socket string, development bool) string {
	connect := "'self'"
	if socket != "" {
		connect += " " + socket
	}
	script := "'self'"
	if development {
		// Vite injects inline React refresh code into development HTML.
		script += " 'unsafe-inline'"
	}
	return "default-src 'self'; " +
		"script-src " + script + "; " +
		"script-src-attr 'none'; " +
		"style-src 'self' 'unsafe-inline'; " +
		"connect-src " + connect + "; " +
		"font-src 'self' data: blob:; " +
		"img-src 'self' data: blob:; " +
		"media-src 'self' blob:; " +
		"worker-src 'self' blob:; " +
		"manifest-src 'self'; " +
		"frame-src 'self' blob:; " +
		"object-src 'none'; " +
		"base-uri 'none'; " +
		"form-action 'self'; " +
		"frame-ancestors 'none'"
}

// socketOrigin is the WebSocket origin of the page, ws or wss plus the
// host the browser asked for. Like a URL origin it is lower case and drops
// the default port. A Host with bytes that do not belong in a host gives
// "", so a crafted Host cannot add CSP directives.
func socketOrigin(r *http.Request) string {
	host := strings.ToLower(r.Host)
	if host == "" || strings.IndexFunc(host, notHostRune) >= 0 {
		return ""
	}
	scheme, defaultPort := "ws", "80"
	if requestScheme(r) == "https" {
		scheme, defaultPort = "wss", "443"
	}
	if name, port, err := net.SplitHostPort(host); err == nil && (port == "" || port == defaultPort) {
		host = name
		if strings.Contains(name, ":") {
			host = "[" + name + "]"
		}
	}
	return scheme + "://" + host
}

func notHostRune(c rune) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		return false
	}
	return !strings.ContainsRune(".-_:[]", c)
}

// requestScheme is the scheme the browser used: https over TLS, or when
// the first X-Forwarded-Proto value says so. TLS proxies set that header.
// A direct client may send it too. That is safe here because
// the value only shapes the response to that same client.
func requestScheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	proto, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
	if strings.EqualFold(strings.TrimSpace(proto), "https") {
		return "https"
	}
	return "http"
}
