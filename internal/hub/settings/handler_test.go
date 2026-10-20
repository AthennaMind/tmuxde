package settings

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// testToken is the configured token. Logs must never contain it.
const testToken = "settings-test-token-0123456789"

// notifyLog records Notify calls.
type notifyLog struct {
	mu    sync.Mutex
	calls []string
}

func (n *notifyLog) notify(name, etag string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.calls = append(n.calls, name+" "+etag)
}

func (n *notifyLog) list() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.calls...)
}

type fixture struct {
	store  *Store
	notes  *notifyLog
	logs   *bytes.Buffer
	server http.Handler
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{store: tempStore(t), notes: &notifyLog{}, logs: &bytes.Buffer{}}
	f.server = New(Options{
		Token:  testToken,
		Store:  f.store,
		Notify: f.notes.notify,
		Logger: slog.New(slog.NewTextHandler(f.logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
	})
	return f
}

// do sends one request. headers are pairs of name and value.
func (f *fixture) do(method, path string, body io.Reader, headers ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, body)
	for i := 0; i+1 < len(headers); i += 2 {
		r.Header.Set(headers[i], headers[i+1])
	}
	w := httptest.NewRecorder()
	f.server.ServeHTTP(w, r)
	return w
}

const bearer = "Bearer " + testToken

func wantStatus(t *testing.T, w *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d, want %d, body %q", w.Code, status, w.Body.String())
	}
	if body != "" && w.Body.String() != body {
		t.Fatalf("body %q, want %q", w.Body.String(), body)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control %q, want no-store", got)
	}
}

func TestGetMissingDocument(t *testing.T) {
	f := newFixture(t)
	for _, tt := range []struct{ path, body string }{
		{SettingsPath, "{}"},
		{KeybindingsPath, "[]"},
	} {
		w := f.do(http.MethodGet, tt.path, nil, "Authorization", bearer)
		wantStatus(t, w, http.StatusOK, tt.body)
		hdr := w.Header()
		if hdr.Get("Content-Type") != "application/json" {
			t.Errorf("%s Content-Type %q", tt.path, hdr.Get("Content-Type"))
		}
		if hdr.Get("ETag") != ETag([]byte(tt.body)) {
			t.Errorf("%s ETag %q, want %q", tt.path, hdr.Get("ETag"), ETag([]byte(tt.body)))
		}
	}
	if len(f.notes.list()) != 0 {
		t.Fatalf("GET notified: %v", f.notes.list())
	}
}

func TestPutThenGet(t *testing.T) {
	f := newFixture(t)
	body := "[\n  { \"key\": \"ctrl+shift+b\", \"command\": \"sidebar.toggle\" }\n]\n"
	w := f.do(http.MethodPut, KeybindingsPath, strings.NewReader(body),
		"Authorization", bearer, "If-Match", ETag([]byte("[]")))
	wantStatus(t, w, http.StatusNoContent, "")
	etag := w.Header().Get("ETag")
	if etag != ETag([]byte(body)) {
		t.Fatalf("PUT ETag %q, want %q", etag, ETag([]byte(body)))
	}
	if w.Body.Len() != 0 {
		t.Fatalf("204 with body %q", w.Body.String())
	}
	if got := f.notes.list(); len(got) != 1 || got[0] != NameKeybindings+" "+etag {
		t.Fatalf("Notify calls %v, want one for keybindings %s", got, etag)
	}

	w = f.do(http.MethodGet, KeybindingsPath, nil, "Authorization", bearer)
	wantStatus(t, w, http.StatusOK, body)
	if w.Header().Get("ETag") != etag {
		t.Fatalf("GET ETag %q, want %q", w.Header().Get("ETag"), etag)
	}

	// Star replaces whatever is stored.
	w = f.do(http.MethodPut, SettingsPath, strings.NewReader(`{"a.b":1}`), "Authorization", bearer, "If-Match", "*")
	wantStatus(t, w, http.StatusNoContent, "")
	if got := f.notes.list(); len(got) != 2 || got[1] != NameSettings+" "+w.Header().Get("ETag") {
		t.Fatalf("Notify calls %v", got)
	}
}

func TestStatusCodes(t *testing.T) {
	f := newFixture(t)
	// Store a document so a stale If-Match exists.
	w := f.do(http.MethodPut, SettingsPath, strings.NewReader(`{"a.b":1}`), "Authorization", bearer, "If-Match", "*")
	wantStatus(t, w, http.StatusNoContent, "")
	before := len(f.notes.list())
	stale := ETag([]byte("{}"))

	tests := []struct {
		name    string
		method  string
		path    string
		body    string
		headers []string
		status  int
		text    string
	}{
		{"POST", http.MethodPost, SettingsPath, "{}", []string{"Authorization", bearer}, 405, bodyMethod},
		{"DELETE", http.MethodDelete, SettingsPath, "", []string{"Authorization", bearer}, 405, bodyMethod},
		{"HEAD", http.MethodHead, SettingsPath, "", []string{"Authorization", bearer}, 405, ""},
		{"method before name", http.MethodPost, "/user/other", "", nil, 405, bodyMethod},
		{"unknown name", http.MethodGet, "/user/other", "", []string{"Authorization", bearer}, 404, bodyNotFound},
		{"name with suffix", http.MethodGet, "/user/settings.json", "", []string{"Authorization", bearer}, 404, bodyNotFound},
		{"name below", http.MethodGet, "/user/settings/x", "", []string{"Authorization", bearer}, 404, bodyNotFound},
		{"no name", http.MethodGet, "/user/", "", []string{"Authorization", bearer}, 404, bodyNotFound},
		{"other prefix", http.MethodGet, "/file/settings", "", []string{"Authorization", bearer}, 404, bodyNotFound},
		{"name before token", http.MethodGet, "/user/other", "", nil, 404, bodyNotFound},
		{"no token", http.MethodGet, SettingsPath, "", nil, 401, bodyUnauthorized},
		{"wrong token", http.MethodGet, SettingsPath, "", []string{"Authorization", "Bearer wrong"}, 401, bodyUnauthorized},
		{"empty bearer", http.MethodGet, SettingsPath, "", []string{"Authorization", "Bearer "}, 401, bodyUnauthorized},
		{"other scheme", http.MethodGet, SettingsPath, "", []string{"Authorization", "Basic " + testToken}, 401, bodyUnauthorized},
		{"lower case scheme", http.MethodGet, SettingsPath, "", []string{"Authorization", "bearer " + testToken}, 401, bodyUnauthorized},
		{"PUT without token", http.MethodPut, SettingsPath, `{"a.b":2}`, []string{"If-Match", "*"}, 401, bodyUnauthorized},
		{"token before If-Match", http.MethodPut, SettingsPath, `{"a.b":2}`, nil, 401, bodyUnauthorized},
		{"no If-Match", http.MethodPut, SettingsPath, `{"a.b":2}`, []string{"Authorization", bearer}, 428, bodyNoIfMatch},
		{"blank If-Match", http.MethodPut, SettingsPath, `{"a.b":2}`, []string{"Authorization", bearer, "If-Match", " "}, 428, bodyNoIfMatch},
		{"If-Match before size", http.MethodPut, SettingsPath, strings.Repeat(" ", MaxBytes+1), []string{"Authorization", bearer}, 428, bodyNoIfMatch},
		{"too large", http.MethodPut, SettingsPath, `{"a.b":"` + strings.Repeat("x", MaxBytes) + `"}`, []string{"Authorization", bearer, "If-Match", "*"}, 413, bodyTooLarge},
		{"size before validation", http.MethodPut, SettingsPath, strings.Repeat("x", MaxBytes+1), []string{"Authorization", bearer, "If-Match", stale}, 413, bodyTooLarge},
		{"invalid JSON", http.MethodPut, SettingsPath, `{`, []string{"Authorization", bearer, "If-Match", "*"}, 400, bodyInvalid},
		{"invalid key", http.MethodPut, SettingsPath, `{"Bad":1}`, []string{"Authorization", bearer, "If-Match", "*"}, 400, bodyInvalid},
		{"wrong document kind", http.MethodPut, KeybindingsPath, `{}`, []string{"Authorization", bearer, "If-Match", "*"}, 400, bodyInvalid},
		{"empty body", http.MethodPut, SettingsPath, ``, []string{"Authorization", bearer, "If-Match", "*"}, 400, bodyInvalid},
		{"validation before stale", http.MethodPut, SettingsPath, `[]`, []string{"Authorization", bearer, "If-Match", stale}, 400, bodyInvalid},
		{"stale", http.MethodPut, SettingsPath, `{"a.b":2}`, []string{"Authorization", bearer, "If-Match", stale}, 412, bodyStale},
		{"weak tag", http.MethodPut, SettingsPath, `{"a.b":2}`, []string{"Authorization", bearer, "If-Match", "W/" + ETag([]byte(`{"a.b":1}`))}, 412, bodyStale},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var body io.Reader
			if tt.body != "" {
				body = strings.NewReader(tt.body)
			}
			w := f.do(tt.method, tt.path, body, tt.headers...)
			wantStatus(t, w, tt.status, tt.text)
			if tt.status == http.StatusMethodNotAllowed && w.Header().Get("Allow") != "GET, PUT" {
				t.Errorf("Allow %q", w.Header().Get("Allow"))
			}
			if tt.status != http.StatusOK && w.Header().Get("ETag") != "" {
				t.Errorf("error answer has ETag %q", w.Header().Get("ETag"))
			}
		})
	}
	if got := f.notes.list(); len(got) != before {
		t.Fatalf("failed requests notified: %v", got[before:])
	}
	stored, _, err := f.store.Load(NameSettings)
	if err != nil || string(stored) != `{"a.b":1}` {
		t.Fatalf("failed requests changed the document: %q, %v", stored, err)
	}
	if strings.Contains(f.logs.String(), testToken) {
		t.Fatal("logs contain the token")
	}
}

func TestEmptyConfiguredTokenRefusesAll(t *testing.T) {
	h := New(Options{Store: tempStore(t)})
	for _, auth := range []string{"", "Bearer ", "Bearer x"} {
		r := httptest.NewRequest(http.MethodGet, SettingsPath, nil)
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("Authorization %q: status %d, want 401", auth, w.Code)
		}
	}
}

func TestBodyLimitAtBoundary(t *testing.T) {
	f := newFixture(t)
	prefix, suffix := `{"a.b":"`, `"}`
	body := prefix + strings.Repeat("x", MaxBytes-len(prefix)-len(suffix)) + suffix
	w := f.do(http.MethodPut, SettingsPath, strings.NewReader(body), "Authorization", bearer, "If-Match", "*")
	wantStatus(t, w, http.StatusNoContent, "")
	w = f.do(http.MethodPut, SettingsPath, strings.NewReader(body+" "), "Authorization", bearer, "If-Match", "*")
	wantStatus(t, w, http.StatusRequestEntityTooLarge, bodyTooLarge)
	if got := f.notes.list(); len(got) != 1 {
		t.Fatalf("Notify calls %v, want one", got)
	}
}

func TestStoreFailureIs500(t *testing.T) {
	f := newFixture(t)
	// A file in place of the config dir breaks every read and write.
	parent := t.TempDir()
	f.store.Dir = parent + "/file/config"
	if err := writeBlocker(parent + "/file"); err != nil {
		t.Fatal(err)
	}
	w := f.do(http.MethodGet, SettingsPath, nil, "Authorization", bearer)
	wantStatus(t, w, http.StatusInternalServerError, bodyUnavailable)
	w = f.do(http.MethodPut, SettingsPath, strings.NewReader(`{}`), "Authorization", bearer, "If-Match", "*")
	wantStatus(t, w, http.StatusInternalServerError, bodyUnavailable)
	if len(f.notes.list()) != 0 {
		t.Fatalf("failed write notified: %v", f.notes.list())
	}
	if !strings.Contains(f.logs.String(), "user document") {
		t.Fatalf("store errors not logged: %s", f.logs.String())
	}
}

func TestNilNotify(t *testing.T) {
	h := New(Options{Token: testToken, Store: tempStore(t)})
	r := httptest.NewRequest(http.MethodPut, SettingsPath, strings.NewReader(`{}`))
	r.Header.Set("Authorization", bearer)
	r.Header.Set("If-Match", "*")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status %d", w.Code)
	}
}

func TestNewPanicsWithoutStore(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("New without a store did not panic")
		}
	}()
	New(Options{Token: testToken})
}
