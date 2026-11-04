package update

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testRelease() Release {
	release := Release{
		ID:        100,
		Tag:       "v1.2.0",
		URL:       "https://github.com/" + Repository + "/releases/tag/v1.2.0",
		Published: "2026-11-04T00:00:00Z",
	}
	for index, name := range []string{
		"checksums.txt",
		"checksums.txt.sigstore.json",
		"tmuxde_1.2.0_linux_amd64.tar.gz",
		"tmuxde-stt_1.2.0_linux_amd64.tar.gz",
	} {
		release.Assets = append(release.Assets, Asset{
			ID:   int64(index + 1),
			Name: name,
			Size: 100,
			URL:  "https://github.com/" + Repository + "/releases/download/v1.2.0/" + name,
		})
	}
	return release
}

func TestReleaseCheckRejectsUnexpectedMetadata(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*Release)
		valid  bool
	}{
		{name: "stable", valid: true},
		{name: "draft", change: func(r *Release) { r.Draft = true }},
		{name: "prerelease", change: func(r *Release) { r.Prerelease = true }},
		{name: "tag injection", change: func(r *Release) { r.Tag = "v1.2.0/../../../file" }},
		{name: "foreign release", change: func(r *Release) { r.URL = "https://example.com" }},
		{name: "foreign asset", change: func(r *Release) { r.Assets[0].URL = "http://127.0.0.1/private" }},
		{name: "large asset", change: func(r *Release) { r.Assets[0].Size = maxArchive + 1 }},
		{name: "duplicate asset", change: func(r *Release) { r.Assets = append(r.Assets, r.Assets[0]) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			release := testRelease()
			if test.change != nil {
				test.change(&release)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if err := json.NewEncoder(w).Encode(release); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			source := NewSource()
			source.endpoint = server.URL
			_, err := source.Check(t.Context())
			if (err == nil) != test.valid {
				t.Fatalf("check error = %v, want valid %v", err, test.valid)
			}
		})
	}
}

func TestReleaseEligibility(t *testing.T) {
	for _, test := range []struct {
		version  string
		eligible bool
	}{
		{version: "1.1.0", eligible: true},
		{version: "v1.1.0", eligible: true},
		{version: "1.2.0"},
		{version: "1.10.0"},
		{version: "dev"},
		{version: "v1.1.0-12-gabcdef"},
		{version: "v1.1.0-dirty"},
		{version: "1.2.0-rc1"},
	} {
		t.Run(test.version, func(t *testing.T) {
			component := Component{
				ID:      "server",
				Kind:    "server",
				Version: test.version,
				OS:      "linux",
				Arch:    "amd64",
				Online:  true,
			}
			result := testRelease().offered(component)
			if result.Eligible != test.eligible {
				t.Fatalf("eligibility = %+v", result)
			}
			component.Reason = "Managed by Docker"
			if result := testRelease().offered(component); result.Eligible {
				t.Fatal("offered container update")
			}
		})
	}
}

func TestReleaseRateLimitAndResponseBound(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusTooManyRequests, http.StatusOK} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
			if status == http.StatusOK {
				_, _ = w.Write([]byte(strings.Repeat(" ", maxMetadata+1)))
			}
		}))
		source := NewSource()
		source.endpoint = server.URL
		if _, err := source.Check(t.Context()); err == nil {
			t.Fatalf("accepted response with status %d", status)
		}
		server.Close()
	}
}
