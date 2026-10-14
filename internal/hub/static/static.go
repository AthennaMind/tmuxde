// Package static serves the built web app from a file system, in practice
// the embed in tmuxde/web.
//
// Rules:
//   - A file that exists is served with the type from contentTypes and a
//     strong ETag from its content. If-None-Match and Range work.
//   - /assets/ is immutable for a year. Vite puts a content hash in those
//     names. Everything else is no-cache, index.html, sw.js, manifest.json
//     and offline.html included, so a new build shows on the next load.
//   - A missing path with a file extension, or below /assets/, is 404.
//   - Any other missing path gets index.html, so deep links load the app.
//   - GET and HEAD only. No directory listings. Dot files are never served.
//   - Without index.html every request is 503 "web build missing".
//
// The edge sends /_relay, /file and /health elsewhere, so they never reach
// this handler.
package static

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"
)

// Options configure the handler.
type Options struct {
	// Logger receives files that could not be read at startup. Nil means
	// slog.Default().
	Logger *slog.Logger
}

// indexFile is the page for the root and for every app route.
const indexFile = "index.html"

// Cache-Control values.
const (
	// Hashed names never change content, so the browser keeps them.
	cacheImmutable = "public, max-age=31536000, immutable"
	// The browser keeps a copy but asks with If-None-Match before each use.
	cacheRevalidate = "no-cache"
)

// immutablePrefix holds the Vite build assets. Their names carry a content
// hash.
const immutablePrefix = "assets/"

// contentTypes is the MIME table. The table is explicit because the type
// must not depend on /etc/mime.types of the host. A scratch image has none.
// Other extensions get application/octet-stream.
var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json",
	".map":         "application/json",
	".webmanifest": "application/manifest+json",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".ico":         "image/x-icon",
	".woff2":       "font/woff2",
	".woff":        "font/woff",
	// Monaco ships its codicon font as ttf.
	".ttf":  "font/ttf",
	".wasm": "application/wasm",
	".txt":  "text/plain; charset=utf-8",
}

const defaultContentType = "application/octet-stream"

// file is what the handler knows about one file, computed once at startup.
type file struct {
	etag         string
	contentType  string
	cacheControl string
}

type handler struct {
	fsys  fs.FS
	files map[string]file
}

// Handler serves fsys. It reads every file once to compute its ETag. A
// file it cannot read is logged and then answers as missing.
func Handler(fsys fs.FS, opts Options) http.Handler {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	files := index(fsys, logger)
	if _, ok := files[indexFile]; !ok {
		return http.HandlerFunc(missingBuild)
	}
	return &handler{fsys: fsys, files: files}
}

// index walks fsys and returns every regular file that is not a dot file,
// keyed by its slash separated name.
func index(fsys fs.FS, logger *slog.Logger) map[string]file {
	files := map[string]file{}
	err := fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			logger.Warn("web build: cannot read", "path", name, "error", err)
			return nil
		}
		if name != "." && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			logger.Warn("web build: cannot read", "path", name, "error", err)
			return nil
		}
		sum := sha256.Sum256(data)
		files[name] = file{
			etag:         `"` + hex.EncodeToString(sum[:16]) + `"`,
			contentType:  contentType(name),
			cacheControl: cacheControl(name),
		}
		return nil
	})
	if err != nil {
		logger.Warn("web build: cannot read", "error", err)
	}
	return files
}

func contentType(name string) string {
	if ct, ok := contentTypes[strings.ToLower(path.Ext(name))]; ok {
		return ct
	}
	return defaultContentType
}

func cacheControl(name string) string {
	if strings.HasPrefix(name, immutablePrefix) {
		return cacheImmutable
	}
	return cacheRevalidate
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		text(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	// Clean drops dot segments, so a name never leaves fsys.
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = indexFile
	}
	f, ok := h.files[name]
	if !ok {
		if path.Ext(name) != "" || strings.HasPrefix(name, immutablePrefix) {
			text(w, http.StatusNotFound, "Not found")
			return
		}
		// An app route. The router in index.html takes it from here.
		name = indexFile
		f = h.files[indexFile]
	}
	h.serve(w, r, name, f)
}

// serve writes one file. ServeContent answers If-None-Match, Range and
// HEAD. The zero modification time keeps Last-Modified out: the embed has
// no times, and the ETag covers revalidation.
func (h *handler) serve(w http.ResponseWriter, r *http.Request, name string, f file) {
	content, err := h.open(name)
	if err != nil {
		text(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if c, ok := content.(io.Closer); ok {
		defer c.Close()
	}
	header := w.Header()
	header.Set("Content-Type", f.contentType)
	header.Set("Cache-Control", f.cacheControl)
	header.Set("ETag", f.etag)
	// The edge leaves asset paths without security headers. The type
	// above is exact, so browsers must not guess another one.
	header.Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, time.Time{}, content)
}

// open returns the file as an io.ReadSeeker. Files of embed.FS, os.DirFS
// and fstest.MapFS seek. Others are read into memory.
func (h *handler) open(name string) (io.ReadSeeker, error) {
	f, err := h.fsys.Open(name)
	if err != nil {
		return nil, err
	}
	if rs, ok := f.(io.ReadSeeker); ok {
		return rs, nil
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(data), nil
}

// missingBuild answers every request when the build has no index.html.
func missingBuild(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	text(w, http.StatusServiceUnavailable, "web build missing")
}

func text(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	io.WriteString(w, msg)
}
