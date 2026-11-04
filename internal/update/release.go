package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/mod/semver"
)

var stable = regexp.MustCompile(`^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func version(v string) string {
	if !stable.MatchString(v) {
		return ""
	}
	return "v" + strings.TrimPrefix(v, "v")
}

type Source struct {
	client   *http.Client
	endpoint string
}

// NewSource builds a release client without making a network request.
func NewSource() *Source {
	return &Source{
		endpoint: "https://api.github.com/repos/" + Repository + "/releases/latest",
		client: &http.Client{
			Timeout: 15 * time.Minute,
			CheckRedirect: func(r *http.Request, via []*http.Request) error {
				if len(via) > 5 || !releaseURL(r.URL) {
					return errors.New("unsupported release redirect")
				}
				return nil
			},
		},
	}
}

func releaseURL(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	switch u.Hostname() {
	case "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	}
	return false
}

func (s *Source) get(ctx context.Context, address string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "TmuxDE-manual-updater")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, errors.New("release download unavailable")
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		if resp.StatusCode == 403 || resp.StatusCode == 429 {
			return nil, errors.New("GitHub rate limit reached. Try again later")
		}
		return nil, fmt.Errorf("release request failed (%d)", resp.StatusCode)
	}
	return resp, nil
}

func (s *Source) Check(ctx context.Context) (*Snapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	resp, err := s.get(ctx, s.endpoint)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxMetadata+1))
	if err != nil || len(b) > maxMetadata {
		return nil, errors.New("invalid release response")
	}
	var r Release
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errors.New("invalid release metadata")
	}
	if r.Draft || r.Prerelease || version(r.Tag) == "" || r.ID <= 0 {
		return nil, errors.New("no stable release available")
	}
	if r.URL != "https://github.com/"+Repository+"/releases/tag/"+r.Tag {
		return nil, errors.New("invalid release link")
	}
	seen := map[string]bool{}
	for _, a := range r.Assets {
		expectedURL := "https://github.com/" + Repository + "/releases/download/" + r.Tag + "/" + a.Name
		if seen[a.Name] || a.ID <= 0 || a.Size < 1 || a.Size > maxArchive {
			return nil, errors.New("invalid release asset")
		}
		if filepath.Base(a.Name) != a.Name || a.URL != expectedURL {
			return nil, errors.New("invalid release asset")
		}
		seen[a.Name] = true
	}
	return &Snapshot{ID: newID(), Checked: time.Now().UTC(), Release: r}, nil
}

func (r Release) asset(name string) (Asset, error) {
	for _, a := range r.Assets {
		if a.Name == name {
			return a, nil
		}
	}
	return Asset{}, fmt.Errorf("release lacks %s", name)
}

func (r Release) offered(c Component) Component {
	c.Eligible = false
	c.Available = strings.TrimPrefix(r.Tag, "v")
	if c.Reason != "" || !c.Online {
		return c
	}
	if version(c.Version) == "" {
		c.Reason = "Custom build requires manual update"
		return c
	}
	if semver.Compare(version(c.Version), version(r.Tag)) >= 0 {
		c.Reason = "Up to date"
		return c
	}
	for _, name := range []string{"checksums.txt", "checksums.txt.sigstore.json"} {
		if _, err := r.asset(name); err != nil {
			c.Reason = "Release does not support in-app updates"
			return c
		}
	}
	a, err := r.asset(assetName(c, r.Tag))
	if err != nil {
		c.Reason = "No release for this platform"
		return c
	}
	c.Eligible = true
	c.Size = a.Size
	return c
}

func assetName(c Component, tag string) string {
	name := "tmuxde"
	if c.Kind == "speech" {
		name = "tmuxde-stt"
	}
	return fmt.Sprintf("%s_%s_%s_%s.tar.gz", name, strings.TrimPrefix(tag, "v"), c.OS, c.Arch)
}

func (s *Source) bytes(ctx context.Context, a Asset) ([]byte, error) {
	if a.Size > maxMetadata {
		return nil, errors.New("release metadata too large")
	}
	resp, err := s.get(ctx, a.URL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, a.Size+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) != a.Size {
		return nil, errors.New("release metadata size changed")
	}
	if err := checkDigest(b, a.Digest); err != nil {
		return nil, err
	}
	return b, nil
}

func checkDigest(b []byte, expected string) error {
	if expected == "" {
		return nil
	}
	h := sha256.Sum256(b)
	if expected != "sha256:"+hex.EncodeToString(h[:]) {
		return errors.New("release asset changed since check")
	}
	return nil
}

func (s *Source) Download(ctx context.Context, r Release, c Component, dir string) (Package, error) {
	p := Package{Tag: r.Tag}
	var err error
	metadata := []struct {
		name        string
		destination *[]byte
	}{
		{name: "checksums.txt", destination: &p.Checksums},
		{name: "checksums.txt.sigstore.json", destination: &p.Bundle},
	}
	for _, file := range metadata {
		asset, err := r.asset(file.name)
		if err != nil {
			return p, err
		}
		data, err := s.bytes(ctx, asset)
		if err != nil {
			return p, err
		}
		*file.destination = data
	}
	p.Asset, err = r.asset(assetName(c, r.Tag))
	if err != nil {
		return p, err
	}
	if err := Verify(p); err != nil {
		return p, err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return p, err
	}
	p.Archive = filepath.Join(dir, p.Asset.Name)
	if verifyArchive(p) == nil {
		return p, nil
	}
	resp, err := s.get(ctx, p.Asset.URL)
	if err != nil {
		return p, err
	}
	defer resp.Body.Close()
	f, err := os.CreateTemp(dir, "download-*")
	if err != nil {
		return p, err
	}
	defer os.Remove(f.Name())
	n, err := io.Copy(f, io.LimitReader(resp.Body, p.Asset.Size+1))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return p, err
	}
	if n != p.Asset.Size {
		return p, errors.New("archive size mismatch")
	}
	p.Archive = f.Name()
	if err := verifyArchive(p); err != nil {
		return p, err
	}
	final := filepath.Join(dir, p.Asset.Name)
	if err := os.Rename(p.Archive, final); err != nil {
		return p, err
	}
	p.Archive = final
	return p, nil
}
