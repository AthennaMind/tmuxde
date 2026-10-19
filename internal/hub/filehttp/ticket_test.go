package filehttp

import (
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// post sends one ticket request with the right bearer unless headers say
// otherwise. A header with an empty value is removed.
func (f *fixture) post(t *testing.T, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		if v == "" {
			r.Header.Del(k)
			continue
		}
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, r)
	if strings.Contains(f.logs.String(), testToken) {
		t.Errorf("logs contain the token: %s", f.logs.String())
	}
	return rec
}

// mint asks the route for a ticket and fails the test on anything but
// success.
func (f *fixture) mint(t *testing.T, path, machine string) string {
	t.Helper()
	body, err := json.Marshal(ticketRequest{Path: path, Machine: machine})
	if err != nil {
		t.Fatal(err)
	}
	rec := f.post(t, TicketPath, string(body), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("ticket status = %d, body %q", rec.Code, rec.Body.String())
	}
	var res ticketResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("ticket body %q: %v", rec.Body.String(), err)
	}
	if res.Ticket == "" {
		t.Fatal("empty ticket")
	}
	return res.Ticket
}

// noAuth drops the bearer the helpers add by default.
var noAuth = map[string]string{"Authorization": ""}

func withTicket(p, ticket string, extra ...string) string {
	return fileURL(p, append([]string{"ticket=" + url.QueryEscape(ticket)}, extra...)...)
}

func TestTicketOpensItsFile(t *testing.T) {
	f := newFixture(t)
	p := f.write(t, "clip.mp4", "0123456789")

	body, _ := json.Marshal(ticketRequest{Path: p})
	rec := f.post(t, TicketPath, string(body), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
	var res map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if len(res) != 2 || res["expiresIn"] != float64(900) {
		t.Errorf("body = %s", rec.Body.String())
	}
	ticket, _ := res["ticket"].(string)
	if raw, err := base64.RawURLEncoding.DecodeString(ticket); err != nil || len(raw) != ticketBytes {
		t.Errorf("ticket %q is not %d url safe base64 bytes: %v", ticket, ticketBytes, err)
	}

	// The whole file, a range and a download, all without a bearer.
	rec = f.do(t, http.MethodGet, withTicket(p, ticket), noAuth)
	wantResponse(t, rec, 200, "0123456789")
	wantRouteHeaders(t, rec.Header())
	if got := rec.Header().Get("Content-Type"); got != "video/mp4" {
		t.Errorf("Content-Type = %q", got)
	}
	rec = f.do(t, http.MethodGet, withTicket(p, ticket), map[string]string{"Authorization": "", "Range": "bytes=2-4"})
	wantResponse(t, rec, 206, "234")
	if got := rec.Header().Get("Content-Range"); got != "bytes 2-4/10" {
		t.Errorf("Content-Range = %q", got)
	}
	rec = f.do(t, http.MethodGet, withTicket(p, ticket, "download=1"), noAuth)
	wantResponse(t, rec, 200, "0123456789")
	if got := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "attachment;") {
		t.Errorf("Content-Disposition = %q", got)
	}
	if strings.Contains(f.logs.String(), "Deprecated") {
		t.Errorf("a ticket logged the deprecation warning: %s", f.logs.String())
	}
}

func TestTicketScope(t *testing.T) {
	const wrong = "0000000000000000000000000000000000000000000000000000000000000000"
	f := newFixture(t)
	a := f.write(t, "a.txt", "aaa")
	b := f.write(t, "b.txt", "bbb")
	local := f.mint(t, a, "")
	beta := f.mint(t, a, "beta")
	// A changed MAC byte. The last character only carries padding bits,
	// which the decoder ignores, so a byte in the middle flips instead.
	tampered := local[:20] + map[bool]string{true: "B", false: "A"}[local[20] == 'A'] + local[21:]
	short := base64.RawURLEncoding.EncodeToString([]byte("0123456789"))

	tests := []struct {
		name    string
		target  string
		headers map[string]string
		want    int
	}{
		{name: "its own file", target: withTicket(a, local), want: 200},
		{name: "another file", target: withTicket(b, local), want: 401},
		{name: "another machine", target: withTicket(a, local, "machine=beta"), want: 401},
		{name: "machine ticket on local", target: withTicket(a, beta), want: 401},
		{name: "tampered", target: withTicket(a, tampered), want: 401},
		{name: "garbage", target: withTicket(a, "not-a-ticket"), want: 401},
		{name: "wrong length", target: withTicket(a, short), want: 401},
		{name: "empty", target: withTicket(a, ""), want: 401},
		{name: "wrong bearer beats ticket", target: withTicket(a, local), headers: map[string]string{"Authorization": "Bearer " + wrong}, want: 401},
		{name: "empty bearer beats ticket", target: withTicket(a, local), headers: map[string]string{"Authorization": "Bearer "}, want: 401},
		{name: "right bearer with a bad ticket", target: withTicket(a, "nope"), headers: map[string]string{"Authorization": "Bearer " + testToken}, want: 200},
		{name: "ticket beats wrong query token", target: withTicket(a, local, "token="+wrong), want: 200},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			headers := map[string]string{"Authorization": ""}
			for k, v := range tt.headers {
				headers[k] = v
			}
			calls := f.opener.callCount()
			rec := f.do(t, http.MethodGet, tt.target, headers)
			if tt.want == 200 {
				wantResponse(t, rec, 200, "aaa")
				return
			}
			wantResponse(t, rec, 401, "Unauthorized")
			if n := f.opener.callCount(); n != calls {
				t.Errorf("opener called on a refused request")
			}
		})
	}

	// The machine ticket opens the file when the request names its machine.
	// The fixture has no resolver, so the plain opener answers.
	rec := f.do(t, http.MethodGet, withTicket(a, beta, "machine=beta"), noAuth)
	wantResponse(t, rec, 200, "aaa")

	// A ticket mints nothing, with or without the deprecated query token.
	body, _ := json.Marshal(ticketRequest{Path: b})
	rec = f.post(t, TicketPath+"?ticket="+url.QueryEscape(local), string(body), noAuth)
	wantResponse(t, rec, 401, "Unauthorized")
	rec = f.post(t, TicketPath+"?token="+testToken, string(body), noAuth)
	wantResponse(t, rec, 401, "Unauthorized")
}

func TestTicketExpires(t *testing.T) {
	f := newFixture(t)
	p := f.write(t, "a.txt", "aaa")
	f.now = time.Date(2026, time.October, 18, 12, 0, 0, 0, time.UTC)
	ticket := f.mint(t, p, "")

	f.now = f.now.Add(TicketTTL - time.Second)
	wantResponse(t, f.do(t, http.MethodGet, withTicket(p, ticket), noAuth), 200, "aaa")
	f.now = f.now.Add(2 * time.Second)
	wantResponse(t, f.do(t, http.MethodGet, withTicket(p, ticket), noAuth), 401, "Unauthorized")

	// A new process has a new key, so an old ticket is worth nothing.
	f.now = time.Time{}
	fresh := f.mint(t, p, "")
	f.h = New(Options{Token: testToken, Opener: f.opener, Logger: slog.New(slog.NewTextHandler(f.logs, nil))})
	wantResponse(t, f.do(t, http.MethodGet, withTicket(p, fresh), noAuth), 401, "Unauthorized")
}

func TestTicketRequestErrors(t *testing.T) {
	const wrong = "0000000000000000000000000000000000000000000000000000000000000000"
	f := newFixture(t)
	p := f.write(t, "a.txt", "aaa")
	body, _ := json.Marshal(ticketRequest{Path: p})

	rec := f.do(t, http.MethodGet, TicketPath, nil)
	wantResponse(t, rec, 405, "Method not allowed")
	if got := rec.Header().Get("Allow"); got != "POST" {
		t.Errorf("Allow = %q", got)
	}

	tests := []struct {
		name    string
		body    string
		headers map[string]string
		want    int
		wantMsg string
	}{
		{name: "no bearer", body: string(body), headers: noAuth, want: 401, wantMsg: "Unauthorized"},
		{name: "wrong bearer", body: string(body), headers: map[string]string{"Authorization": "Bearer " + wrong}, want: 401, wantMsg: "Unauthorized"},
		{name: "basic scheme", body: string(body), headers: map[string]string{"Authorization": "Basic " + testToken}, want: 401, wantMsg: "Unauthorized"},
		{name: "bad json", body: "{", want: 400, wantMsg: "Invalid request"},
		{name: "not an object", body: `"x"`, want: 400, wantMsg: "Invalid request"},
		{name: "empty path", body: `{"path":""}`, want: 400, wantMsg: "Missing path parameter"},
		{name: "no path", body: `{"machine":"beta"}`, want: 400, wantMsg: "Missing path parameter"},
		{name: "oversized body", body: `{"path":"` + strings.Repeat("a", ticketBodyLimit) + `"}`, want: 400, wantMsg: "Invalid request"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := f.post(t, TicketPath, tt.body, tt.headers)
			wantResponse(t, rec, tt.want, tt.wantMsg)
			if n := f.opener.callCount(); n != 0 {
				t.Errorf("minting opened a file")
			}
		})
	}

	t.Run("nothing configured", func(t *testing.T) {
		f.h = New(Options{Opener: f.opener, Logger: slog.New(slog.NewTextHandler(f.logs, nil))})
		wantResponse(t, f.post(t, TicketPath, string(body), nil), 401, "Unauthorized")
	})
}
