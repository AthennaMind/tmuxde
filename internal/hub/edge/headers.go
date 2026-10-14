package edge

import (
	"net"
	"net/http"
	"path"
	"slices"
	"strings"
)

// securityHeaders are the header names the edge owns. The dev proxy drops
// upstream copies of these on pages so the edge values are the only ones.
var securityHeaders = []string{
	"Content-Security-Policy",
	"Permissions-Policy",
	"X-Frame-Options",
	"X-Content-Type-Options",
	"Referrer-Policy",
}

// setSecurityHeaders sets the headers the Next proxy.ts of the web app set,
// with the values it built when the relay is same origin (relay URL
// empty). The policy itself follows .docker/Caddyfile, see
// contentSecurityPolicy. socket comes from socketOrigin.
func setSecurityHeaders(h http.Header, socket string) {
	h.Set("Content-Security-Policy", contentSecurityPolicy(socket))
	// Microphone for dictation, this origin only. Nothing records until
	// the user presses the mic and the browser asks.
	h.Set("Permissions-Policy", "microphone=(self), camera=(), geolocation=()")
	h.Set("X-Frame-Options", "DENY")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
}

// contentSecurityPolicy is the policy .docker/Caddyfile sets, byte for byte
// and in the same order, with socket as the only extra connect-src source.
// Caddy names wss://{$LOCAL_DOMAIN} there. An empty socket leaves 'self'
// alone.
//
// proxy.ts builds a weaker policy. It has no blob: in media-src and
// frame-src, and no object-src, base-uri, form-action or frame-ancestors.
// The file viewer plays video and audio and shows PDF from blob: object
// URLs, so it needs blob: in media-src and frame-src. Behind Caddy that
// never showed, because Caddy replaces the header. The binary serves
// without Caddy, so it sends the Caddy policy itself.
func contentSecurityPolicy(socket string) string {
	connect := "'self'"
	if socket != "" {
		connect += " " + socket
	}
	return "default-src 'self'; " +
		"script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
		"style-src 'self' 'unsafe-inline'; " +
		"connect-src " + connect + "; " +
		"font-src 'self' data:; " +
		"img-src 'self' data: blob:; " +
		"media-src 'self' blob:; " +
		"worker-src 'self' blob:; " +
		"frame-src 'self' blob:; " +
		"object-src 'none'; " +
		"base-uri 'self'; " +
		"form-action 'self'; " +
		"frame-ancestors 'none'"
}

// socketOrigin is the WebSocket origin of the page, ws or wss plus the
// host the browser asked for. proxy.ts takes the request origin and swaps
// http for ws. Like a URL origin it is lower case and drops the default
// port. A Host with bytes that do not belong in a host gives "", so a
// crafted Host cannot add CSP directives.
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
// the first X-Forwarded-Proto value says so. Caddy terminates TLS and sets
// that header. A direct client may send it too. That is safe here because
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

// Asset paths get no security headers from the edge. They carry no app
// content. offline.html is served by the service worker from cache.
// Pages, index.html and every app route, keep the headers.
//
// The list follows the Vite build: /assets/ holds the hashed bundles, and
// the files of src/ui/public sit at the root, with the fonts below
// /fonts/.
//
// Every asset name has a file extension. A path without one is never an
// asset, even below /assets/ or /fonts/. The static handler answers such a
// path with index.html, so it must keep the headers like any page.

// assetPrefixes match a path that starts with them.
var assetPrefixes = []string{
	// Vite bundles and public/fonts.
	"/assets/",
	"/fonts/",
}

// assetFiles match exactly.
var assetFiles = []string{
	"/favicon.ico",
	"/icon.svg",
	"/icon-192.png",
	"/icon-512.png",
	"/icon-maskable-512.png",
	"/apple-icon.png",
	"/manifest.json",
	"/offline.html",
	"/sw.js",
	"/dictation-worklet.js",
	"/robots.txt",
}

func isAsset(urlPath string) bool {
	if path.Ext(urlPath) == "" {
		return false
	}
	for _, p := range assetPrefixes {
		if strings.HasPrefix(urlPath, p) {
			return true
		}
	}
	return slices.Contains(assetFiles, urlPath)
}
