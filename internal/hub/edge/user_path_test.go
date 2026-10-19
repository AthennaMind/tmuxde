package edge

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The user documents live below /user/. No path there may reach the web
// app, mounted or not.
func TestUserPathsStayOnHub(t *testing.T) {
	for _, p := range []string{"/user", "/user/", "/user/settings", "/user/keybindings", "/user/other"} {
		if !isHubPath(p) {
			t.Errorf("isHubPath(%q) = false, want true", p)
		}
	}
	for _, p := range []string{"/users", "/userx/settings"} {
		if isHubPath(p) {
			t.Errorf("isHubPath(%q) = true, want false", p)
		}
	}

	web := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("web"))
	})
	e := New(Options{Static: web})
	e.Handle("/user/settings", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("settings"))
	}))
	tests := []struct {
		path   string
		status int
		body   string
	}{
		{"/user/settings", http.StatusOK, "settings"},
		{"/user/keybindings", http.StatusNotFound, "Not found"},
		{"/user/", http.StatusNotFound, "Not found"},
		{"/users", http.StatusOK, "web"},
	}
	for _, tt := range tests {
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tt.path, nil))
		if rec.Code != tt.status || rec.Body.String() != tt.body {
			t.Errorf("GET %s = %d %q, want %d %q", tt.path, rec.Code, rec.Body.String(), tt.status, tt.body)
		}
	}
}
