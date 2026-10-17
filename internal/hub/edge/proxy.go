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

// devProxy forwards requests to the web dev server. Pages get the edge
// security headers in place of the upstream ones. Assets pass through as
// the dev server sent them.
//
// WebSocket upgrades such as the HMR socket go through too. ReverseProxy
// answers 101 itself and then copies bytes both ways. A mis-routed HMR
// upgrade used to hang, and Chromium, which opens WebSocket handshakes to
// one host one at a time, then never tried /_relay.
type devProxy struct {
	page  *httputil.ReverseProxy
	asset *httputil.ReverseProxy
}

func newDevProxy(target *url.URL, logger *slog.Logger) *devProxy {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// The dev server is local. Never send it through a proxy from the
	// environment.
	transport.Proxy = nil
	build := func(modify func(*http.Response) error) *httputil.ReverseProxy {
		return &httputil.ReverseProxy{
			Rewrite: func(pr *httputil.ProxyRequest) {
				pr.SetURL(target)
				// Keep the Host the browser sent. The dev server checks hosts
				// and builds URLs from it.
				pr.Out.Host = pr.In.Host
				// For, Host and Proto from this hop only. Inbound copies
				// are already dropped by Rewrite.
				pr.SetXForwarded()
				// Preserve browser scheme when a proxy terminates TLS.
				pr.Out.Header.Set("X-Forwarded-Proto", requestScheme(pr.In))
			},
			Transport: transport,
			// Write each chunk at once, so HMR and event streams do not
			// wait in a buffer.
			FlushInterval:  -1,
			ModifyResponse: modify,
			ErrorHandler:   proxyErrorHandler(logger),
			ErrorLog:       slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
		}
	}
	return &devProxy{
		page:  build(dropSecurityHeaders),
		asset: build(nil),
	}
}

// socketOriginKey carries the socket origin of the browser request to the
// error handler. ReverseProxy hands that handler the outbound request, whose
// Host and headers are the proxy's choice, not the browser's.
type socketOriginKey struct{}

func (p *devProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	r = r.WithContext(context.WithValue(r.Context(), socketOriginKey{}, socketOrigin(r)))
	if isAsset(r.URL.Path) {
		p.asset.ServeHTTP(w, r)
		return
	}
	p.page.ServeHTTP(w, r)
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
		// This answer comes from the edge, so it carries the headers even
		// on an asset path.
		socket, _ := r.Context().Value(socketOriginKey{}).(string)
		setSecurityHeaders(w.Header(), socket)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "Bad gateway")
	}
}
