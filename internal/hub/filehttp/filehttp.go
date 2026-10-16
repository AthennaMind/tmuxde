// Package filehttp serves GET /file, the download route of the hub. The
// file viewer loads images, video, audio and PDF through it, and download=1
// saves a file. It ports the /file branch of handleRelayRequest in
// apps/relay/src/server.ts and the MIME table in apps/relay/src/mime.ts.
//
// The hub never touches the file system here. It checks the token, asks
// the node for an open file through node.FileOpener and copies the bytes.
// The node applies its path guards before it opens anything.
//
// The request is handled in this order:
//
//  1. Anything but GET on exactly /file with a query is 404 "Not found".
//     HEAD too, as in the relay.
//  2. No token or a wrong one is 401 "Unauthorized". The token comes from
//     "Authorization: Bearer <token>". The token query parameter is a
//     deprecated fallback and logs a warning. There is no auth throttle on
//     this route, as in the relay.
//  3. No path parameter is 400 "Missing path parameter".
//  4. node.ErrDenied is 403 "Access denied". node.ErrNotFile is 404 "Not a
//     file". Any other open error is 404 "File not found".
//  5. A Range header gives 206 or 416. Everything else is 200.
//
// Differences from the relay:
//   - The node opens the path it checked, so the guard and the open see
//     the same file.
//   - A range that ends before it starts is 416, like one that starts past
//     the end.
//   - A download name with characters above U+00FF is served. The relay
//     failed to write that header and answered 404.
package filehttp

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"tmuxde/internal/hub/auth"
	"tmuxde/internal/node"
)

// Path is the only path this handler serves.
const Path = "/file"

// Bodies of the error answers. The browser shows some of them.
const (
	bodyNotFound     = "Not found"
	bodyUnauthorized = "Unauthorized"
	bodyMissingPath  = "Missing path parameter"
	bodyDenied       = "Access denied"
	bodyNotFile      = "Not a file"
	bodyFileNotFound = "File not found"
)

// bearerPrefix starts the Authorization header. The match is case
// sensitive, as in the relay.
const bearerPrefix = "Bearer "

// Options configure New.
type Options struct {
	// Token is AUTH_TOKEN. Empty refuses every request.
	Token string
	// Opener opens files behind the node path guards. It must not be nil.
	Opener node.FileOpener
	// Resolve chooses a machine after token validation.
	Resolve func(string) (node.FileOpener, error)
	// Logger gets the deprecated token warning and serve errors. Nil means
	// slog.Default(). The token never reaches it.
	Logger *slog.Logger
}

type handler struct {
	token   string
	opener  node.FileOpener
	resolve func(string) (node.FileOpener, error)
	log     *slog.Logger
}

// New returns the GET /file handler. It panics when opts.Opener is nil.
func New(opts Options) http.Handler {
	if opts.Opener == nil && opts.Resolve == nil {
		panic("filehttp: Options.Opener is nil")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &handler{token: opts.Token, opener: opts.Opener, resolve: opts.Resolve, log: logger}
}

// ServeHTTP answers one request. See the package doc for the order.
func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// The relay matched req.url.startsWith("/file?"), so "/file?" with an
	// empty query counts as well.
	hasQuery := r.URL.RawQuery != "" || r.URL.ForceQuery
	if r.Method != http.MethodGet || r.URL.Path != Path || !hasQuery {
		writeText(w, http.StatusNotFound, bodyNotFound)
		return
	}
	hdr := w.Header()
	hdr.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	hdr.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

	query := r.URL.Query()
	if !h.authorized(r, query.Get("token")) {
		writeText(w, http.StatusUnauthorized, bodyUnauthorized)
		return
	}
	filePath := query.Get("path")
	if filePath == "" {
		writeText(w, http.StatusBadRequest, bodyMissingPath)
		return
	}
	h.serve(w, r, filePath, query.Get("download") == "1")
}

// authorized checks the bearer token, or the deprecated query token when
// the request has no bearer. A bearer header always wins, even an empty
// one, as in the relay. The query token puts the credential in browser
// history and access logs, so its use is logged. The token itself is not.
func (h *handler) authorized(r *http.Request, queryToken string) bool {
	bearer, hasBearer := strings.CutPrefix(r.Header.Get("Authorization"), bearerPrefix)
	if !hasBearer {
		bearer = ""
	}
	if bearer == "" && queryToken != "" {
		h.log.Warn("Deprecated ?token= used on /file; send Authorization: Bearer instead")
	}
	token := queryToken
	if hasBearer {
		token = bearer
	}
	if token == "" || h.token == "" {
		return false
	}
	return auth.TokenEqual(token, h.token)
}

// serve opens filePath through the node and writes it, whole or one range.
func (h *handler) serve(w http.ResponseWriter, r *http.Request, filePath string, download bool) {
	opener := h.opener
	if h.resolve != nil {
		var err error
		opener, err = h.resolve(r.URL.Query().Get("machine"))
		if err != nil {
			writeText(w, http.StatusServiceUnavailable, "Machine offline")
			return
		}
	}
	f, err := opener.OpenFile(r.Context(), filePath)
	if err != nil {
		h.openFailed(w, filePath, err)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		h.log.Error("File serve error", "path", filePath, "err", err)
		writeText(w, http.StatusNotFound, bodyFileNotFound)
		return
	}
	if !info.Mode().IsRegular() {
		writeText(w, http.StatusNotFound, bodyNotFile)
		return
	}
	size := info.Size()

	status := http.StatusOK
	start, length := int64(0), size
	if s, e, ok := parseRange(r.Header.Get("Range")); ok {
		if s >= size || e < s {
			w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(size, 10))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		e = min(e, size-1)
		status = http.StatusPartialContent
		start, length = s, e-s+1
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		h.log.Error("File serve error", "path", filePath, "err", err)
		writeText(w, http.StatusNotFound, bodyFileNotFound)
		return
	}

	// The relay names the file after the path as asked, not the target of
	// a symlink.
	name := filepath.Base(filepath.Clean(filePath))
	hdr := w.Header()
	hdr.Set("Content-Type", mimeType(name))
	hdr.Set("Cache-Control", "private, max-age=60")
	if download {
		hdr.Set("Content-Disposition", contentDisposition(name))
	}
	if status == http.StatusPartialContent {
		hdr.Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+
			strconv.FormatInt(start+length-1, 10)+"/"+strconv.FormatInt(size, 10))
	}
	hdr.Set("Content-Length", strconv.FormatInt(length, 10))
	hdr.Set("Accept-Ranges", "bytes")
	w.WriteHeader(status)
	if _, err := io.CopyN(w, f, length); err != nil {
		// Headers are out. A browser that went away or a file that shrank
		// ends here, and the short body tells the browser.
		h.log.Debug("File copy stopped", "path", filePath, "err", err)
	}
}

// openFailed maps an OpenFile error to its answer. Only errors that are
// not one of the node sentinels are logged.
func (h *handler) openFailed(w http.ResponseWriter, filePath string, err error) {
	switch {
	case errors.Is(err, node.ErrDenied):
		writeText(w, http.StatusForbidden, bodyDenied)
	case errors.Is(err, node.ErrNotFile):
		writeText(w, http.StatusNotFound, bodyNotFile)
	case errors.Is(err, node.ErrNotFound):
		writeText(w, http.StatusNotFound, bodyFileNotFound)
	default:
		h.log.Error("File serve error", "path", filePath, "err", err)
		writeText(w, http.StatusNotFound, bodyFileNotFound)
	}
}

func writeText(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}
