package updates

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tmuxde/internal/update"
)

func TestAuthorizationBeforeUpdateOperations(t *testing.T) {
	// A nil manager makes any accidental dispatch fail the test.
	handler := &Handler{Token: "private-test-token", Origins: []string{"https://hub.test"}}
	for _, test := range []struct {
		name   string
		token  string
		origin string
		status int
	}{
		{name: "missing token", status: http.StatusUnauthorized},
		{name: "wrong token", token: "wrong", status: http.StatusUnauthorized},
		{name: "foreign origin", token: "private-test-token", origin: "https://foreign.test", status: http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, path := range []string{"/updates/check", "/updates/jobs", "/updates/jobs/job/cancel"} {
				request := httptest.NewRequest(http.MethodPost, path, nil)
				request.Header.Set("Authorization", "Bearer "+test.token)
				request.Header.Set("Origin", test.origin)
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if response.Code != test.status {
					t.Fatalf("%s: status = %d", path, response.Code)
				}
			}
		})
	}
}

func TestUpdateRequestValidation(t *testing.T) {
	manager, err := update.NewManager(t.TempDir(), func() []update.Target {
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	handler := &Handler{Token: "private-test-token", Manager: manager}
	for _, body := range []string{
		`{}`, `{"url":"https://example.com"}`, `{} {}`, strings.Repeat(" ", 17<<10),
		`{"id":"request","snapshot":"snapshot","targets":["server"]}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/updates/jobs", strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer private-test-token")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest && response.Code != http.StatusConflict {
			t.Fatalf("accepted invalid or unchecked selection: %d", response.Code)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/updates", nil)
	request.Header.Set("Authorization", "Bearer private-test-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"snapshot":null`) {
		t.Fatalf("status unexpectedly checked a release: %s", response.Body.String())
	}
}
