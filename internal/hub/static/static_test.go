package static

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"
)

// site is a small build: index.html, a hashed asset, the service worker,
// the manifest and a font.
var site = os.DirFS("testdata/site")

func quiet() Options {
	return Options{Logger: slog.New(slog.DiscardHandler)}
}

func readSite(t *testing.T, name string) string {
	t.Helper()
	data, err := fs.ReadFile(site, name)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// etagOf is the ETag the handler must send for content.
func etagOf(content string) string {
	sum := sha256.Sum256([]byte(content))
	return `"` + hex.EncodeToString(sum[:16]) + `"`
}

func request(h http.Handler, method, target string, header http.Header) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, nil)
	for k, v := range header {
		r.Header[k] = v
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func TestHandler(t *testing.T) {
	h := Handler(site, quiet())
	index := readSite(t, "index.html")
	app := readSite(t, "assets/app-abc123.js")
	sw := readSite(t, "sw.js")
	manifest := readSite(t, "manifest.json")
	font := readSite(t, "fonts/x.woff2")

	const (
		html = "text/html; charset=utf-8"
		js   = "text/javascript; charset=utf-8"
	)
	tests := []struct {
		name   string
		method string
		path   string
		header http.Header
		code   int
		body   string
		// ctype, cache and etag are checked when the response is a file.
		ctype, cache, etag string
	}{
		{name: "root", path: "/", code: 200, body: index, ctype: html, cache: "no-cache", etag: etagOf(index)},
		{name: "index by name", path: "/index.html", code: 200, body: index, ctype: html, cache: "no-cache", etag: etagOf(index)},
		{name: "app route", path: "/login", code: 200, body: index, ctype: html, cache: "no-cache", etag: etagOf(index)},
		{name: "deep link", path: "/s/work", code: 200, body: index, ctype: html, cache: "no-cache", etag: etagOf(index)},
		{name: "trailing slash", path: "/s/work/", code: 200, body: index, ctype: html, cache: "no-cache", etag: etagOf(index)},
		{name: "directory has no listing", path: "/fonts/", code: 200, body: index, ctype: html, cache: "no-cache", etag: etagOf(index)},
		{name: "query is ignored", path: "/s/work?pane=%251", code: 200, body: index, ctype: html, cache: "no-cache", etag: etagOf(index)},
		{name: "hashed asset", path: "/assets/app-abc123.js", code: 200, body: app, ctype: js, cache: "public, max-age=31536000, immutable", etag: etagOf(app)},
		{name: "service worker", path: "/sw.js", code: 200, body: sw, ctype: js, cache: "no-cache", etag: etagOf(sw)},
		{name: "manifest", path: "/manifest.json", code: 200, body: manifest, ctype: "application/json", cache: "no-cache", etag: etagOf(manifest)},
		{name: "font", path: "/fonts/x.woff2", code: 200, body: font, ctype: "font/woff2", cache: "no-cache", etag: etagOf(font)},
		{name: "dot segments stay inside", path: "/assets/../sw.js", code: 200, body: sw, ctype: js, cache: "no-cache", etag: etagOf(sw)},
		{name: "parent of root", path: "/../../etc/passwd", code: 200, body: index, ctype: html, cache: "no-cache", etag: etagOf(index)},
		{name: "missing file", path: "/missing.js", code: 404, body: "Not found"},
		{name: "missing asset", path: "/assets/app-old999.js", code: 404, body: "Not found"},
		{name: "asset path without extension", path: "/assets/app", code: 404, body: "Not found"},
		{name: "missing font", path: "/fonts/y.woff2", code: 404, body: "Not found"},
		{name: "head of a file", method: "HEAD", path: "/assets/app-abc123.js", code: 200, ctype: js, cache: "public, max-age=31536000, immutable", etag: etagOf(app)},
		{name: "head of an app route", method: "HEAD", path: "/login", code: 200, ctype: html, cache: "no-cache", etag: etagOf(index)},
		// The handler writes the text. The server drops it for HEAD.
		{name: "head of a missing file", method: "HEAD", path: "/missing.css", code: 404, body: "Not found"},
		{
			name: "if-none-match hit", path: "/assets/app-abc123.js",
			header: http.Header{"If-None-Match": {etagOf(app)}},
			code:   304, cache: "public, max-age=31536000, immutable", etag: etagOf(app),
		},
		{
			name: "if-none-match hit on an app route", path: "/s/work",
			header: http.Header{"If-None-Match": {etagOf(index)}},
			code:   304, cache: "no-cache", etag: etagOf(index),
		},
		{
			name: "if-none-match weak hit", path: "/sw.js",
			header: http.Header{"If-None-Match": {"W/" + etagOf(sw)}},
			code:   304, cache: "no-cache", etag: etagOf(sw),
		},
		{
			name: "if-none-match in a list", path: "/sw.js",
			header: http.Header{"If-None-Match": {`"old", ` + etagOf(sw)}},
			code:   304, cache: "no-cache", etag: etagOf(sw),
		},
		{
			name: "if-none-match miss", path: "/sw.js",
			header: http.Header{"If-None-Match": {etagOf("old")}},
			code:   200, body: sw, ctype: js, cache: "no-cache", etag: etagOf(sw),
		},
		{
			name: "range", path: "/sw.js",
			header: http.Header{"Range": {"bytes=0-3"}},
			code:   206, body: sw[:4], ctype: js, cache: "no-cache", etag: etagOf(sw),
		},
		{name: "post", method: "POST", path: "/login", code: 405, body: "Method not allowed"},
		{name: "put on a file", method: "PUT", path: "/sw.js", code: 405, body: "Method not allowed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			method := tt.method
			if method == "" {
				method = "GET"
			}
			rec := request(h, method, tt.path, tt.header)
			if rec.Code != tt.code || rec.Body.String() != tt.body {
				t.Fatalf("%s %s = %d %q, want %d %q", method, tt.path, rec.Code, rec.Body, tt.code, tt.body)
			}
			got := rec.Header()
			if got.Get("X-Content-Type-Options") != "nosniff" {
				t.Errorf("X-Content-Type-Options = %q, want nosniff", got.Get("X-Content-Type-Options"))
			}
			if tt.code == 304 {
				// The type of a body that is not sent goes too.
				if got.Get("Content-Type") != "" {
					t.Errorf("Content-Type = %q on 304", got.Get("Content-Type"))
				}
			} else if tt.ctype != "" && got.Get("Content-Type") != tt.ctype {
				t.Errorf("Content-Type = %q, want %q", got.Get("Content-Type"), tt.ctype)
			}
			if got.Get("Cache-Control") != tt.cache {
				t.Errorf("Cache-Control = %q, want %q", got.Get("Cache-Control"), tt.cache)
			}
			if got.Get("ETag") != tt.etag {
				t.Errorf("ETag = %q, want %q", got.Get("ETag"), tt.etag)
			}
			if got.Get("Last-Modified") != "" {
				t.Errorf("Last-Modified = %q, want none", got.Get("Last-Modified"))
			}
			if tt.code == 405 && got.Get("Allow") != "GET, HEAD" {
				t.Errorf("Allow = %q", got.Get("Allow"))
			}
			if method == "HEAD" && tt.code == 200 {
				if got.Get("Content-Length") == "" {
					t.Error("HEAD has no Content-Length")
				}
			}
		})
	}
}

// TestMissingBuild covers dist with no index.html, as in a checkout that
// never ran the web build: it holds only .gitkeep.
func TestMissingBuild(t *testing.T) {
	for name, fsys := range map[string]fs.FS{
		"gitkeep only":     fstest.MapFS{".gitkeep": {}},
		"empty":            fstest.MapFS{},
		"assets, no index": fstest.MapFS{"assets/app-abc123.js": {Data: []byte("x")}},
	} {
		t.Run(name, func(t *testing.T) {
			h := Handler(fsys, quiet())
			for _, target := range []string{"/", "/login", "/assets/app-abc123.js", "/.gitkeep"} {
				for _, method := range []string{"GET", "HEAD", "POST"} {
					rec := request(h, method, target, nil)
					if rec.Code != http.StatusServiceUnavailable || rec.Body.String() != "web build missing" {
						t.Fatalf("%s %s = %d %q, want 503 %q", method, target, rec.Code, rec.Body, "web build missing")
					}
					if ct := rec.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
						t.Fatalf("Content-Type = %q", ct)
					}
					if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
						t.Fatalf("Cache-Control = %q, want no-store", cc)
					}
				}
			}
		})
	}
}

func TestContentTypes(t *testing.T) {
	names := map[string]string{
		"page.html":         "text/html; charset=utf-8",
		"app.js":            "text/javascript; charset=utf-8",
		"worker.mjs":        "text/javascript; charset=utf-8",
		"style.css":         "text/css; charset=utf-8",
		"data.json":         "application/json",
		"app.js.map":        "application/json",
		"site.webmanifest":  "application/manifest+json",
		"icon.svg":          "image/svg+xml",
		"icon-192.png":      "image/png",
		"favicon.ico":       "image/x-icon",
		"font.woff2":        "font/woff2",
		"font.woff":         "font/woff",
		"codicon.ttf":       "font/ttf",
		"onig.wasm":         "application/wasm",
		"robots.txt":        "text/plain; charset=utf-8",
		"UPPER.JS":          "text/javascript; charset=utf-8",
		"archive.tar.gz":    "application/octet-stream",
		"LICENSE":           "application/octet-stream",
		"assets/photo.webp": "application/octet-stream",
	}
	fsys := fstest.MapFS{"index.html": {Data: []byte("<!doctype html>")}}
	for name := range names {
		fsys[name] = &fstest.MapFile{Data: []byte(name)}
	}
	h := Handler(fsys, quiet())
	for name, want := range names {
		t.Run(name, func(t *testing.T) {
			rec := request(h, "GET", "/"+name, nil)
			if rec.Code != 200 || rec.Body.String() != name {
				t.Fatalf("GET /%s = %d %q", name, rec.Code, rec.Body)
			}
			if got := rec.Header().Get("Content-Type"); got != want {
				t.Fatalf("Content-Type = %q, want %q", got, want)
			}
		})
	}
}

// TestDotFilesHidden checks that dot files and dot directories are never
// served, even when the build holds them.
func TestDotFilesHidden(t *testing.T) {
	index := "<!doctype html>"
	h := Handler(fstest.MapFS{
		"index.html":        {Data: []byte(index)},
		".gitkeep":          {},
		".env":              {Data: []byte("SECRET=1")},
		".git/config":       {Data: []byte("[core]")},
		"assets/.hidden.js": {Data: []byte("hidden")},
	}, quiet())
	tests := []struct {
		path string
		code int
		body string
	}{
		{"/.gitkeep", 404, "Not found"},
		{"/.env", 404, "Not found"},
		{"/assets/.hidden.js", 404, "Not found"},
		// No extension, so it is an app route.
		{"/.git/config", 200, index},
	}
	for _, tt := range tests {
		rec := request(h, "GET", tt.path, nil)
		if rec.Code != tt.code || rec.Body.String() != tt.body {
			t.Errorf("GET %s = %d %q, want %d %q", tt.path, rec.Code, rec.Body, tt.code, tt.body)
		}
	}
}

// brokenFS hides Seek on its files and fails to open one name. Only Open
// is exposed, so fs.ReadFile and fs.WalkDir go through it.
type brokenFS struct {
	fs  fstest.MapFS
	bad string
}

func (b brokenFS) Open(name string) (fs.File, error) {
	if name == b.bad {
		return nil, errors.New("disk on fire")
	}
	f, err := b.fs.Open(name)
	if err != nil {
		return nil, err
	}
	if _, ok := f.(fs.ReadDirFile); ok {
		return f, nil
	}
	return noSeek{f}, nil
}

// noSeek is a file without Seek.
type noSeek struct{ fs.File }

// TestUnreadableFile checks that a file the startup walk cannot read is
// logged and then missing, and that files without Seek are still served.
func TestUnreadableFile(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	h := Handler(brokenFS{
		fs: fstest.MapFS{
			"index.html": {Data: []byte("<!doctype html>")},
			"sw.js":      {Data: []byte("worker")},
			"broken.js":  {Data: []byte("never")},
		},
		bad: "broken.js",
	}, Options{Logger: logger})

	if rec := request(h, "GET", "/broken.js", nil); rec.Code != 404 {
		t.Fatalf("GET /broken.js = %d, want 404", rec.Code)
	}
	if !strings.Contains(logs.String(), "path=broken.js") || !strings.Contains(logs.String(), "disk on fire") {
		t.Fatalf("log %q does not name the file and the error", logs.String())
	}
	rec := request(h, "GET", "/sw.js", http.Header{"Range": {"bytes=1-3"}})
	if rec.Code != 206 || rec.Body.String() != "ork" {
		t.Fatalf("GET /sw.js = %d %q, want 206 %q", rec.Code, rec.Body, "ork")
	}
}

// TestETagFollowsContent checks that equal content gives equal ETags across
// builds and different content does not.
func TestETagFollowsContent(t *testing.T) {
	build := func(sw string) http.Handler {
		return Handler(fstest.MapFS{
			"index.html": {Data: []byte("<!doctype html>")},
			"sw.js":      {Data: []byte(sw)},
		}, quiet())
	}
	etag := func(h http.Handler) string {
		return request(h, "GET", "/sw.js", nil).Header().Get("ETag")
	}
	a, b, c := etag(build("one")), etag(build("one")), etag(build("two"))
	if a == "" || a != b || a == c {
		t.Fatalf("ETags %q %q %q, want the first two equal and the third different", a, b, c)
	}
}
