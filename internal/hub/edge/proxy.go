package edge

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// devProxy forwards requests to web dev server with edge security headers.
//
// WebSocket upgrades such as the HMR socket go through too. ReverseProxy
// answers 101 itself and then copies bytes both ways. A mis-routed HMR
// upgrade used to hang, and Chromium, which opens WebSocket handshakes to
// one host one at a time, then never tried /_relay.
type devProxy struct {
	proxy *httputil.ReverseProxy
}

func newDevProxy(target *url.URL, logger *slog.Logger) *devProxy {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// The dev server is local. Never send it through a proxy from the
	// environment.
	transport.Proxy = nil
	return &devProxy{proxy: &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// Keep browser host for Vite host and WebSocket origin checks.
			pr.Out.Host = pr.In.Host
			pr.SetXForwarded()
			pr.Out.Header.Set("X-Forwarded-Proto", requestScheme(pr.In))
		},
		Transport: transport,
		// Flush HMR and event streams without waiting for buffers.
		FlushInterval:  -1,
		ModifyResponse: dropSecurityHeaders,
		ErrorHandler:   proxyErrorHandler(logger),
		ErrorLog:       slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}}
}

func (p *devProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.proxy.ServeHTTP(w, r)
}

// dropSecurityHeaders removes upstream copies of the edge headers. The
// edge set its values on the response before proxying, and ReverseProxy
// adds upstream headers rather than replacing them. Two CSP headers would
// both apply.
func dropSecurityHeaders(res *http.Response) error {
	for _, name := range securityHeaders {
		res.Header.Del(name)
	}
	return nil
}

// proxyErrorHandler answers 502 when the dev server cannot be reached. r is
// the outbound request.
func proxyErrorHandler(logger *slog.Logger) func(http.ResponseWriter, *http.Request, error) {
	return func(w http.ResponseWriter, r *http.Request, err error) {
		if errors.Is(err, context.Canceled) {
			// The browser left first.
			logger.Debug("web dev server request canceled", "path", r.URL.Path)
		} else {
			logger.Warn("web dev server request failed", "path", r.URL.Path, "error", err)
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "Bad gateway")
	}
}
