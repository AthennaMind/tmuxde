package settings

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"tmuxde/internal/hub/auth"
)

// Routes of the handler. Mount it on SettingsPath and KeybindingsPath.
const (
	Prefix          = "/user/"
	SettingsPath    = Prefix + NameSettings
	KeybindingsPath = Prefix + NameKeybindings
)

// Bodies of the error answers. They are fixed and never echo input.
const (
	bodyMethod       = "Method not allowed"
	bodyNotFound     = "Not found"
	bodyUnauthorized = "Unauthorized"
	bodyNoIfMatch    = "If-Match required"
	bodyTooLarge     = "Document too large"
	bodyBadRequest   = "Bad request"
	bodyInvalid      = "Invalid document"
	bodyStale        = "Document changed"
	bodyUnavailable  = "Settings unavailable"
)

// bearerPrefix starts the Authorization header. The match is case
// sensitive, as on the other hub routes.
const bearerPrefix = "Bearer "

// Options configure New.
type Options struct {
	// Token is AUTH_TOKEN. Empty refuses every request.
	Token string
	// Store holds the documents. It must not be nil.
	Store *Store
	// Notify runs once after each successful PUT, after the answer is
	// flushed, with the name and the new ETag. Nil skips it.
	Notify func(name, etag string)
	// Logger gets store errors. Nil means slog.Default(). Tokens and
	// document bodies never reach it.
	Logger *slog.Logger
}

type handler struct {
	token  string
	store  *Store
	notify func(name, etag string)
	log    *slog.Logger
}

// New returns the handler of GET and PUT /user/{name}. It panics when
// opts.Store is nil.
//
// Checks run in this order:
//
//  1. A method other than GET or PUT is 405.
//  2. A path that is not /user/settings or /user/keybindings is 404.
//  3. A missing or wrong bearer token is 401.
//  4. GET answers 200 with the document, Content-Type application/json,
//     the ETag and Cache-Control no-store.
//  5. PUT without If-Match is 428. A body over MaxBytes is 413. A body
//     that does not validate is 400. An If-Match that is neither * nor
//     the current ETag is 412. Success is 204 with the new ETag, then
//     Notify runs.
func New(opts Options) http.Handler {
	if opts.Store == nil {
		panic("settings: Options.Store is nil")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &handler{token: opts.Token, store: opts.Store, notify: opts.Notify, log: logger}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPut {
		w.Header().Set("Allow", "GET, PUT")
		writeText(w, http.StatusMethodNotAllowed, bodyMethod)
		return
	}
	name, ok := strings.CutPrefix(r.URL.Path, Prefix)
	if !ok || !Known(name) {
		writeText(w, http.StatusNotFound, bodyNotFound)
		return
	}
	if !h.authorized(r) {
		writeText(w, http.StatusUnauthorized, bodyUnauthorized)
		return
	}
	if r.Method == http.MethodGet {
		h.get(w, name)
		return
	}
	h.put(w, r, name)
}

// authorized checks the bearer token. Nothing matches an empty side.
func (h *handler) authorized(r *http.Request) bool {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), bearerPrefix)
	if !ok || token == "" || h.token == "" {
		return false
	}
	return auth.TokenEqual(token, h.token)
}

func (h *handler) get(w http.ResponseWriter, name string) {
	body, etag, err := h.store.Load(name)
	if err != nil {
		h.log.Error("user document read failed", "name", name, "error", err)
		writeText(w, http.StatusInternalServerError, bodyUnavailable)
		return
	}
	hdr := w.Header()
	hdr.Set("Content-Type", "application/json")
	hdr.Set("ETag", etag)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (h *handler) put(w http.ResponseWriter, r *http.Request, name string) {
	ifMatch := r.Header.Get("If-Match")
	if strings.TrimSpace(ifMatch) == "" {
		writeText(w, http.StatusPreconditionRequired, bodyNoIfMatch)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeText(w, http.StatusRequestEntityTooLarge, bodyTooLarge)
			return
		}
		writeText(w, http.StatusBadRequest, bodyBadRequest)
		return
	}
	etag, err := h.store.Save(name, body, ifMatch)
	switch {
	case err == nil:
	case errors.Is(err, ErrTooLarge):
		writeText(w, http.StatusRequestEntityTooLarge, bodyTooLarge)
		return
	case errors.Is(err, ErrInvalid):
		writeText(w, http.StatusBadRequest, bodyInvalid)
		return
	case errors.Is(err, ErrStale):
		writeText(w, http.StatusPreconditionFailed, bodyStale)
		return
	default:
		h.log.Error("user document write failed", "name", name, "error", err)
		writeText(w, http.StatusInternalServerError, bodyUnavailable)
		return
	}
	w.Header().Set("ETag", etag)
	w.WriteHeader(http.StatusNoContent)
	// The writer is done before the broadcast, so a stalled browser socket
	// does not hold the answer.
	_ = http.NewResponseController(w).Flush()
	if h.notify != nil {
		h.notify(name, etag)
	}
}

func writeText(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}
