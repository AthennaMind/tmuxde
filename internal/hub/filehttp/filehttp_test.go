package filehttp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"tmuxde/internal/node"
)

// testToken is the configured token. Logs must never contain it.
const testToken = "f1le-test-token-0123456789abcdef"

// syncBuffer is a log sink that is safe across the server goroutine and
// the test.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// fakeOpener stands in for the node. It allows paths below root, denies
// paths below denied and everything else, and opens real files from the
// temp dir. err or file, when set, answer every call instead.
type fakeOpener struct {
	root   string
	denied string
	err    error
	file   node.File

	mu     sync.Mutex
	calls  []string
	opened []*trackedFile
}

func (o *fakeOpener) OpenFile(_ context.Context, p string) (node.File, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.calls = append(o.calls, p)
	if o.err != nil {
		return nil, o.err
	}
	if o.file != nil {
		return o.file, nil
	}
	if !filepath.IsAbs(p) {
		return nil, node.ErrDenied
	}
	p = filepath.Clean(p)
	if !within(p, o.root) || (o.denied != "" && within(p, o.denied)) {
		return nil, node.ErrDenied
	}
	info, err := os.Stat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, node.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("stat: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, node.ErrNotFile
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}
	tf := &trackedFile{File: f}
	o.opened = append(o.opened, tf)
	return tf, nil
}

func (o *fakeOpener) callCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.calls)
}

func (o *fakeOpener) lastCall() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.calls) == 0 {
		return ""
	}
	return o.calls[len(o.calls)-1]
}

// wantAllClosed fails unless every file the opener handed out is closed.
func (o *fakeOpener) wantAllClosed(t *testing.T) {
	t.Helper()
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, f := range o.opened {
		if !f.closed {
			t.Errorf("file %s was not closed", f.Name())
		}
	}
}

func within(p, root string) bool {
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}

// trackedFile records Close.
type trackedFile struct {
	*os.File
	closed bool
}

func (f *trackedFile) Close() error {
	f.closed = true
	return f.File.Close()
}

// stubFile is a File whose Stat and Seek can fail.
type stubFile struct {
	*bytes.Reader
	mode    fs.FileMode
	statErr error
	seekErr error
	closed  bool
}

func (f *stubFile) Stat() (fs.FileInfo, error) {
	if f.statErr != nil {
		return nil, f.statErr
	}
	return stubInfo{size: f.Size(), mode: f.mode}, nil
}

func (f *stubFile) Seek(off int64, whence int) (int64, error) {
	if f.seekErr != nil {
		return 0, f.seekErr
	}
	return f.Reader.Seek(off, whence)
}

func (f *stubFile) Close() error {
	f.closed = true
	return nil
}

type stubInfo struct {
	size int64
	mode fs.FileMode
}

func (i stubInfo) Name() string       { return "stub" }
func (i stubInfo) Size() int64        { return i.size }
func (i stubInfo) Mode() fs.FileMode  { return i.mode }
func (i stubInfo) ModTime() time.Time { return time.Time{} }
func (i stubInfo) IsDir() bool        { return i.mode.IsDir() }
func (i stubInfo) Sys() any           { return nil }

// fixture is a handler over a fresh temp dir.
type fixture struct {
	root   string
	opener *fakeOpener
	logs   *syncBuffer
	h      http.Handler
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	denied := filepath.Join(root, "denied")
	if err := os.Mkdir(denied, 0o700); err != nil {
		t.Fatal(err)
	}
	logs := &syncBuffer{}
	logger := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	opener := &fakeOpener{root: root, denied: denied}
	return &fixture{
		root:   root,
		opener: opener,
		logs:   logs,
		h:      New(Options{Token: testToken, Opener: opener, Logger: logger}),
	}
}

// write creates a file below the root and returns its path.
func (f *fixture) write(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(f.root, name)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// fileURL builds /file?path=... with extra query pairs appended raw.
func fileURL(p string, extra ...string) string {
	q := "path=" + url.QueryEscape(p)
	for _, e := range extra {
		q += "&" + e
	}
	return "/file?" + q
}

// do runs one request with the right bearer unless headers say otherwise.
// A header with an empty value is removed.
func (f *fixture) do(t *testing.T, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, nil)
	r.Header.Set("Authorization", "Bearer "+testToken)
	for k, v := range headers {
		if v == "" {
			r.Header.Del(k)
			continue
		}
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, r)
	f.opener.wantAllClosed(t)
	if strings.Contains(f.logs.String(), testToken) {
		t.Errorf("logs contain the token: %s", f.logs.String())
	}
	return rec
}

func wantResponse(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status {
		t.Errorf("status = %d, want %d (body %q)", rec.Code, status, rec.Body.String())
	}
	if got := rec.Body.String(); got != body {
		t.Errorf("body = %q, want %q", got, body)
	}
}

// wantRouteHeaders fails unless the two headers the route always sets are
// there.
func wantRouteHeaders(t *testing.T, h http.Header) {
	t.Helper()
	if got := h.Get("Access-Control-Allow-Methods"); got != "GET, OPTIONS" {
		t.Errorf("Access-Control-Allow-Methods = %q", got)
	}
	if got := h.Get("Access-Control-Allow-Headers"); got != "Content-Type, Authorization" {
		t.Errorf("Access-Control-Allow-Headers = %q", got)
	}
}

func TestNewPanicsWithoutOpener(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("New did not panic")
		}
	}()
	New(Options{Token: testToken})
}

func TestRouteMismatchIsNotFound(t *testing.T) {
	f := newFixture(t)
	p := f.write(t, "a.txt", "hello")
	tests := []struct {
		name, method, target string
	}{
		{"HEAD", http.MethodHead, fileURL(p)},
		{"POST", http.MethodPost, fileURL(p)},
		{"PUT", http.MethodPut, fileURL(p)},
		{"DELETE", http.MethodDelete, fileURL(p)},
		{"OPTIONS", http.MethodOptions, fileURL(p)},
		{"no query", http.MethodGet, "/file"},
		{"sub path", http.MethodGet, "/file/x?path=" + url.QueryEscape(p)},
		{"longer name", http.MethodGet, "/files?path=" + url.QueryEscape(p)},
		{"root", http.MethodGet, "/?path=" + url.QueryEscape(p)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := f.do(t, tt.method, tt.target, nil)
			wantResponse(t, rec, http.StatusNotFound, "Not found")
			if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "" {
				t.Errorf("Access-Control-Allow-Methods = %q, want none off the route", got)
			}
		})
	}
	if n := f.opener.callCount(); n != 0 {
		t.Errorf("opener called %d times, want 0", n)
	}
}

func TestEmptyQueryMatchesRoute(t *testing.T) {
	// The relay matched the prefix "/file?", so a bare "?" is the route and
	// fails on auth, not on routing.
	f := newFixture(t)
	rec := f.do(t, http.MethodGet, "/file?", map[string]string{"Authorization": ""})
	wantResponse(t, rec, http.StatusUnauthorized, "Unauthorized")
	wantRouteHeaders(t, rec.Header())
}

func TestAuth(t *testing.T) {
	const wrong = "0000000000000000000000000000000000000000000000000000000000000000"
	tests := []struct {
		name       string
		authHeader string // empty means no header
		queryToken *string
		configured string
		wantStatus int
		wantWarn   bool
	}{
		{name: "no token", wantStatus: 401},
		{name: "right bearer", authHeader: "Bearer " + testToken, wantStatus: 200},
		{name: "wrong bearer", authHeader: "Bearer " + wrong, wantStatus: 401},
		{name: "lower case scheme", authHeader: "bearer " + testToken, wantStatus: 401},
		{name: "no space after scheme", authHeader: "Bearer" + testToken, wantStatus: 401},
		{name: "two spaces after scheme", authHeader: "Bearer  " + testToken, wantStatus: 401},
		{name: "basic scheme", authHeader: "Basic " + testToken, wantStatus: 401},
		{name: "right query token", queryToken: ptr(testToken), wantStatus: 200, wantWarn: true},
		{name: "wrong query token", queryToken: ptr(wrong), wantStatus: 401, wantWarn: true},
		{name: "empty query token", queryToken: ptr(""), wantStatus: 401},
		{name: "bearer beats wrong query", authHeader: "Bearer " + testToken, queryToken: ptr(wrong), wantStatus: 200},
		{name: "wrong bearer beats right query", authHeader: "Bearer " + wrong, queryToken: ptr(testToken), wantStatus: 401},
		{name: "empty bearer beats right query", authHeader: "Bearer ", queryToken: ptr(testToken), wantStatus: 401, wantWarn: true},
		{name: "other scheme falls back to query", authHeader: "Basic abc", queryToken: ptr(testToken), wantStatus: 200, wantWarn: true},
		{name: "nothing configured, empty bearer", authHeader: "Bearer ", configured: "-", wantStatus: 401},
		{name: "nothing configured, some bearer", authHeader: "Bearer x", configured: "-", wantStatus: 401},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			if tt.configured == "-" {
				f.h = New(Options{Opener: f.opener, Logger: slog.New(slog.NewTextHandler(f.logs, nil))})
			}
			p := f.write(t, "a.txt", "hello")
			var extra []string
			if tt.queryToken != nil {
				extra = append(extra, "token="+url.QueryEscape(*tt.queryToken))
			}
			headers := map[string]string{"Authorization": tt.authHeader}
			rec := f.do(t, http.MethodGet, fileURL(p, extra...), headers)
			wantRouteHeaders(t, rec.Header())
			switch tt.wantStatus {
			case 200:
				wantResponse(t, rec, 200, "hello")
			default:
				wantResponse(t, rec, 401, "Unauthorized")
				if n := f.opener.callCount(); n != 0 {
					t.Errorf("opener called %d times on a refused request", n)
				}
			}
			logs := f.logs.String()
			warned := strings.Contains(logs, "level=WARN") &&
				strings.Contains(logs, "Deprecated ?token= used on /file; send Authorization: Bearer instead")
			if warned != tt.wantWarn {
				t.Errorf("warned = %v, want %v, logs %q", warned, tt.wantWarn, logs)
			}
		})
	}
}

func ptr(s string) *string { return &s }

// TestGateCases ports the two server.gate.test.ts cases that survive the
// removal of the connection gate.
func TestGateCases(t *testing.T) {
	t.Run("bad token is 401 without opening anything", func(t *testing.T) {
		f := newFixture(t)
		p := f.write(t, "hostname", "box\n")
		bad := strings.Repeat("0", 64)
		rec := f.do(t, http.MethodGet, fileURL(p), map[string]string{"Authorization": "Bearer " + bad})
		wantResponse(t, rec, http.StatusUnauthorized, "Unauthorized")
		rec = f.do(t, http.MethodGet, fileURL(p), map[string]string{"Authorization": ""})
		wantResponse(t, rec, http.StatusUnauthorized, "Unauthorized")
		if n := f.opener.callCount(); n != 0 {
			t.Errorf("opener called %d times, want 0", n)
		}
	})
	t.Run("denied path is 403 Access denied", func(t *testing.T) {
		f := newFixture(t)
		outside := filepath.Join(t.TempDir(), "shadow")
		if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
			t.Fatal(err)
		}
		rec := f.do(t, http.MethodGet, fileURL(outside), nil)
		wantResponse(t, rec, http.StatusForbidden, "Access denied")
	})
}

func TestMissingPath(t *testing.T) {
	tests := []struct{ name, target string }{
		{"no path", "/file?download=1"},
		{"empty path", "/file?path="},
		{"bare path key", "/file?path"},
		{"other key", "/file?paths=%2Ftmp"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			rec := f.do(t, http.MethodGet, tt.target, nil)
			wantResponse(t, rec, http.StatusBadRequest, "Missing path parameter")
			wantRouteHeaders(t, rec.Header())
			if n := f.opener.callCount(); n != 0 {
				t.Errorf("opener called %d times, want 0", n)
			}
		})
	}
}

func TestOpenErrors(t *testing.T) {
	tests := []struct {
		name       string
		setup      func(t *testing.T, f *fixture) string
		wantStatus int
		wantBody   string
		wantLogged bool
	}{
		{
			name: "outside every root",
			setup: func(t *testing.T, f *fixture) string {
				p := filepath.Join(t.TempDir(), "x.txt")
				if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
					t.Fatal(err)
				}
				return p
			},
			wantStatus: 403, wantBody: "Access denied",
		},
		{
			name: "inside a denied root",
			setup: func(t *testing.T, f *fixture) string {
				return f.write(t, filepath.Join("denied", "id_ed25519"), "key")
			},
			wantStatus: 403, wantBody: "Access denied",
		},
		{
			name:       "relative path",
			setup:      func(t *testing.T, f *fixture) string { return "a.txt" },
			wantStatus: 403, wantBody: "Access denied",
		},
		{
			name: "directory",
			setup: func(t *testing.T, f *fixture) string {
				p := filepath.Join(f.root, "dir")
				if err := os.Mkdir(p, 0o700); err != nil {
					t.Fatal(err)
				}
				return p
			},
			wantStatus: 404, wantBody: "Not a file",
		},
		{
			name:       "missing",
			setup:      func(t *testing.T, f *fixture) string { return filepath.Join(f.root, "gone.txt") },
			wantStatus: 404, wantBody: "File not found",
		},
		{
			name: "wrapped denied",
			setup: func(t *testing.T, f *fixture) string {
				f.opener.err = fmt.Errorf("guard: %w", node.ErrDenied)
				return "/anything"
			},
			wantStatus: 403, wantBody: "Access denied",
		},
		{
			name: "wrapped not a file",
			setup: func(t *testing.T, f *fixture) string {
				f.opener.err = fmt.Errorf("stat: %w", node.ErrNotFile)
				return "/anything"
			},
			wantStatus: 404, wantBody: "Not a file",
		},
		{
			name: "other error",
			setup: func(t *testing.T, f *fixture) string {
				f.opener.err = errors.New("input/output error")
				return "/anything"
			},
			wantStatus: 404, wantBody: "File not found", wantLogged: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			p := tt.setup(t, f)
			rec := f.do(t, http.MethodGet, fileURL(p), nil)
			wantResponse(t, rec, tt.wantStatus, tt.wantBody)
			wantRouteHeaders(t, rec.Header())
			if got := f.opener.lastCall(); got != p {
				t.Errorf("opener got %q, want %q", got, p)
			}
			logged := strings.Contains(f.logs.String(), "File serve error")
			if logged != tt.wantLogged {
				t.Errorf("logged = %v, want %v, logs %q", logged, tt.wantLogged, f.logs.String())
			}
		})
	}
}

func TestBadOpenFile(t *testing.T) {
	tests := []struct {
		name     string
		file     *stubFile
		wantBody string
	}{
		{"stat fails", &stubFile{statErr: errors.New("stale handle")}, "File not found"},
		{"not regular", &stubFile{mode: fs.ModeDir | 0o755}, "Not a file"},
		{"seek fails", &stubFile{seekErr: errors.New("bad seek")}, "File not found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			tt.file.Reader = bytes.NewReader([]byte("content"))
			f.opener.file = tt.file
			rec := f.do(t, http.MethodGet, fileURL("/x.bin"), nil)
			wantResponse(t, rec, http.StatusNotFound, tt.wantBody)
			wantRouteHeaders(t, rec.Header())
			if !tt.file.closed {
				t.Error("file was not closed")
			}
			if got := rec.Header().Get("Content-Length"); got == "7" {
				t.Error("file headers leaked into the error answer")
			}
		})
	}
}

func TestServeWholeFile(t *testing.T) {
	f := newFixture(t)
	p := f.write(t, "photo.PNG", "\x89PNG body")
	rec := f.do(t, http.MethodGet, fileURL(p), nil)
	wantResponse(t, rec, http.StatusOK, "\x89PNG body")
	wantRouteHeaders(t, rec.Header())
	want := map[string]string{
		"Content-Type":        "image/png",
		"Cache-Control":       "private, max-age=60",
		"Content-Length":      "9",
		"Accept-Ranges":       "bytes",
		"Content-Disposition": "",
		"Content-Range":       "",
		"Etag":                "",
		"Last-Modified":       "",
	}
	for k, v := range want {
		if got := rec.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
}

func TestPathIsDecoded(t *testing.T) {
	f := newFixture(t)
	p := f.write(t, "a b+c%d.txt", "x")
	// QueryEscape writes the space as "+". The handler must read it back.
	rec := f.do(t, http.MethodGet, fileURL(p), nil)
	wantResponse(t, rec, http.StatusOK, "x")
	if got := f.opener.lastCall(); got != p {
		t.Errorf("opener got %q, want %q", got, p)
	}
}

func TestRange(t *testing.T) {
	const content = "0123456789"
	tests := []struct {
		name       string
		rangeHdr   string
		wantStatus int
		wantBody   string
		wantRange  string
	}{
		{"head of file", "bytes=0-4", 206, "01234", "bytes 0-4/10"},
		{"open end", "bytes=5-", 206, "56789", "bytes 5-9/10"},
		{"single byte", "bytes=9-9", 206, "9", "bytes 9-9/10"},
		{"first byte", "bytes=0-0", 206, "0", "bytes 0-0/10"},
		{"end clamped", "bytes=7-100", 206, "789", "bytes 7-9/10"},
		{"huge end clamped", "bytes=2-99999999999999999999999", 206, "23456789", "bytes 2-9/10"},
		{"leading zeros", "bytes=00-01", 206, "01", "bytes 0-1/10"},
		{"first range only", "bytes=0-1,4-5", 206, "01", "bytes 0-1/10"},
		{"not anchored", "junk bytes=2-3", 206, "23", "bytes 2-3/10"},
		{"later match wins over a suffix", "bytes=-1 bytes=6-7", 206, "67", "bytes 6-7/10"},
		{"non ASCII digit ends the number", "bytes=3-\u0661", 206, "3456789", "bytes 3-9/10"},
		{"suffix is a plain 200", "bytes=-3", 200, content, ""},
		{"other unit is a plain 200", "items=0-1", 200, content, ""},
		{"upper case unit is a plain 200", "BYTES=0-1", 200, content, ""},
		{"garbage is a plain 200", "bytes=x-1", 200, content, ""},
		{"start at size", "bytes=10-", 416, "", "bytes */10"},
		{"start past end", "bytes=100-200", 416, "", "bytes */10"},
		{"huge start", "bytes=99999999999999999999999-", 416, "", "bytes */10"},
		{"reversed", "bytes=5-2", 416, "", "bytes */10"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			p := f.write(t, "digits.txt", content)
			rec := f.do(t, http.MethodGet, fileURL(p), map[string]string{"Range": tt.rangeHdr})
			wantResponse(t, rec, tt.wantStatus, tt.wantBody)
			wantRouteHeaders(t, rec.Header())
			h := rec.Header()
			if got := h.Get("Content-Range"); got != tt.wantRange {
				t.Errorf("Content-Range = %q, want %q", got, tt.wantRange)
			}
			if tt.wantStatus == 416 {
				// The relay sent only Content-Range with a 416.
				for _, k := range []string{"Content-Type", "Cache-Control", "Accept-Ranges"} {
					if got := h.Get(k); got != "" {
						t.Errorf("%s = %q on a 416", k, got)
					}
				}
				return
			}
			if got, want := h.Get("Content-Length"), fmt.Sprint(len(tt.wantBody)); got != want {
				t.Errorf("Content-Length = %q, want %q", got, want)
			}
			if got := h.Get("Accept-Ranges"); got != "bytes" {
				t.Errorf("Accept-Ranges = %q", got)
			}
			if got := h.Get("Cache-Control"); got != "private, max-age=60" {
				t.Errorf("Cache-Control = %q", got)
			}
			if got := h.Get("Content-Type"); got != "application/octet-stream" {
				t.Errorf("Content-Type = %q", got)
			}
		})
	}
}

func TestRangeOnEmptyFile(t *testing.T) {
	f := newFixture(t)
	p := f.write(t, "empty", "")
	rec := f.do(t, http.MethodGet, fileURL(p), map[string]string{"Range": "bytes=0-"})
	wantResponse(t, rec, http.StatusRequestedRangeNotSatisfiable, "")
	if got := rec.Header().Get("Content-Range"); got != "bytes */0" {
		t.Errorf("Content-Range = %q", got)
	}
	rec = f.do(t, http.MethodGet, fileURL(p), nil)
	wantResponse(t, rec, http.StatusOK, "")
	if got := rec.Header().Get("Content-Length"); got != "0" {
		t.Errorf("Content-Length = %q", got)
	}
}

func TestDownload(t *testing.T) {
	tests := []struct {
		name     string
		file     string
		wantName string // quoted fallback
		wantStar string // filename* value after UTF-8''
	}{
		{"plain", "plain.txt", "plain.txt", "plain.txt"},
		{"double quote", `say "hi".txt`, "say _hi_.txt", "say%20%22hi%22.txt"},
		{"control characters", "bell\x07\r\nx.txt", "bell___x.txt", "bell%07%0D%0Ax.txt"},
		{"tab and DEL", "tab\tdel\x7f.txt", "tab_del_.txt", "tab%09del%7F.txt"},
		{"backslash", `back\slash.txt`, "back_slash.txt", "back%5Cslash.txt"},
		{"non ASCII", "r\u00e9sum\u00e9 \u65e5\u672c.pdf", "r\u00e9sum\u00e9 \u65e5\u672c.pdf", "r%C3%A9sum%C3%A9%20%E6%97%A5%E6%9C%AC.pdf"},
		{"astral plane", "\U0001F600.png", "\U0001F600.png", "%F0%9F%98%80.png"},
		{"unreserved marks", "a!'()*~-_.txt", "a!'()*~-_.txt", "a!'()*~-_.txt"},
		{"reserved marks", "a;b,c&d=e#f?g@h$.txt", "a;b,c&d=e#f?g@h$.txt", "a%3Bb%2Cc%26d%3De%23f%3Fg%40h%24.txt"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			p := f.write(t, tt.file, "data")
			rec := f.do(t, http.MethodGet, fileURL(p, "download=1"), nil)
			wantResponse(t, rec, http.StatusOK, "data")
			want := `attachment; filename="` + tt.wantName + `"; filename*=UTF-8''` + tt.wantStar
			if got := rec.Header().Get("Content-Disposition"); got != want {
				t.Errorf("Content-Disposition = %q, want %q", got, want)
			}
		})
	}
}

func TestDownloadFlag(t *testing.T) {
	tests := []struct {
		name  string
		extra []string
		want  bool
	}{
		{"absent", nil, false},
		{"one", []string{"download=1"}, true},
		{"zero", []string{"download=0"}, false},
		{"true", []string{"download=true"}, false},
		{"eleven", []string{"download=11"}, false},
		{"first value counts", []string{"download=1", "download=0"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			p := f.write(t, "doc.pdf", "%PDF")
			rec := f.do(t, http.MethodGet, fileURL(p, tt.extra...), nil)
			wantResponse(t, rec, http.StatusOK, "%PDF")
			got := rec.Header().Get("Content-Disposition") != ""
			if got != tt.want {
				t.Errorf("Content-Disposition set = %v, want %v", got, tt.want)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/pdf" {
				t.Errorf("Content-Type = %q", ct)
			}
		})
	}
}

func TestDownloadWithRange(t *testing.T) {
	f := newFixture(t)
	p := f.write(t, "clip.mp4", "0123456789")
	rec := f.do(t, http.MethodGet, fileURL(p, "download=1"), map[string]string{"Range": "bytes=2-3"})
	wantResponse(t, rec, http.StatusPartialContent, "23")
	h := rec.Header()
	if got, want := h.Get("Content-Disposition"), `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`; got != want {
		t.Errorf("Content-Disposition = %q, want %q", got, want)
	}
	if got := h.Get("Content-Type"); got != "video/mp4" {
		t.Errorf("Content-Type = %q", got)
	}
}

func TestMimeType(t *testing.T) {
	tests := []struct{ name, want string }{
		{"a.png", "image/png"},
		{"a.jpg", "image/jpeg"},
		{"a.jpeg", "image/jpeg"},
		{"a.gif", "image/gif"},
		{"a.svg", "image/svg+xml"},
		{"a.webp", "image/webp"},
		{"a.bmp", "image/bmp"},
		{"a.ico", "image/x-icon"},
		{"a.mp4", "video/mp4"},
		{"a.webm", "video/webm"},
		{"a.mov", "video/quicktime"},
		{"a.mp3", "audio/mpeg"},
		{"a.wav", "audio/wav"},
		{"a.ogg", "audio/ogg"},
		{"a.flac", "audio/flac"},
		{"a.m4a", "audio/mp4"},
		{"a.aac", "audio/aac"},
		{"a.pdf", "application/pdf"},
		{"A.PNG", "image/png"},
		{"photo.JpEg", "image/jpeg"},
		{"archive.tar.pdf", "application/pdf"},
		{"..png", "image/png"},
		{"notes.txt", "application/octet-stream"},
		{"archive.tar.gz", "application/octet-stream"},
		{"Makefile", "application/octet-stream"},
		{".png", "application/octet-stream"},
		{"trailing.", "application/octet-stream"},
		{"", "application/octet-stream"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := mimeType(tt.name); got != tt.want {
				t.Errorf("mimeType(%q) = %q, want %q", tt.name, got, tt.want)
			}
		})
	}
	if len(mimeTypes) != 18 {
		t.Errorf("table has %d entries, mime.ts has 18", len(mimeTypes))
	}
}

func TestEncodeURIComponent(t *testing.T) {
	tests := []struct{ in, want string }{
		{"", ""},
		{"AZaz09-_.!~*'()", "AZaz09-_.!~*'()"},
		{" \"#$%&+,/:;<=>?@[\\]^`{|}", "%20%22%23%24%25%26%2B%2C%2F%3A%3B%3C%3D%3E%3F%40%5B%5C%5D%5E%60%7B%7C%7D"},
		{"\u00e9", "%C3%A9"},
		{"\xff", "%FF"},
	}
	for _, tt := range tests {
		if got := encodeURIComponent(tt.in); got != tt.want {
			t.Errorf("encodeURIComponent(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// TestOverHTTP checks a range and a download through a real server, so
// net/http keeps the headers the handler sets.
func TestOverHTTP(t *testing.T) {
	f := newFixture(t)
	p := f.write(t, "line\nbreak.wav", "0123456789")
	srv := httptest.NewServer(f.h)
	defer srv.Close()

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+fileURL(p, "download=1"), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Range", "bytes=3-5")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusPartialContent || string(body) != "345" {
		t.Fatalf("got %d %q, want 206 %q", resp.StatusCode, body, "345")
	}
	want := map[string]string{
		"Content-Type":        "audio/wav",
		"Content-Range":       "bytes 3-5/10",
		"Content-Length":      "3",
		"Accept-Ranges":       "bytes",
		"Cache-Control":       "private, max-age=60",
		"Content-Disposition": `attachment; filename="line_break.wav"; filename*=UTF-8''line%0Abreak.wav`,
	}
	for k, v := range want {
		if got := resp.Header.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if resp.ContentLength != 3 {
		t.Errorf("ContentLength = %d, want 3", resp.ContentLength)
	}
	if strings.Contains(f.logs.String(), testToken) {
		t.Errorf("logs contain the token")
	}
}
