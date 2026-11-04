// Package update installs explicitly requested, signed native releases.
// Constructing a service or reading its status never contacts a release server.
package update

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"tmuxde/internal/buildinfo"
)

const Feature = buildinfo.UpdateProtocol
const Repository = "AthennaMind/tmuxde"
const maxArchive = 1 << 30
const maxPayload = 2 << 30
const maxMetadata = 2 << 20

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

type Component struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Version   string `json:"version"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	Reason    string `json:"reason"`
	Online    bool   `json:"online"`
	Eligible  bool   `json:"eligible"`
	Available string `json:"available"`
	Size      int64  `json:"size"`
}

type Asset struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
}

type Release struct {
	ID         int64   `json:"id"`
	Tag        string  `json:"tag_name"`
	URL        string  `json:"html_url"`
	Published  string  `json:"published_at"`
	Draft      bool    `json:"draft"`
	Prerelease bool    `json:"prerelease"`
	Assets     []Asset `json:"assets"`
}

type Snapshot struct {
	ID      string    `json:"id"`
	Checked time.Time `json:"checked"`
	Release Release   `json:"release"`
}

type Package struct {
	Tag       string `json:"tag"`
	Asset     Asset  `json:"asset"`
	Checksums []byte `json:"checksums"`
	Bundle    []byte `json:"bundle"`
	Archive   string `json:"-"`
}

type Result struct {
	Phase   string `json:"phase"`
	Message string `json:"message"`
}

type Item struct {
	Component   Component `json:"component"`
	Transaction string    `json:"transaction"`
	Result      Result    `json:"result"`
}

type Job struct {
	ID       string    `json:"id"`
	Snapshot string    `json:"snapshot"`
	Version  string    `json:"version"`
	Created  time.Time `json:"created"`
	Active   bool      `json:"active"`
	Items    []Item    `json:"items"`
}

type Status struct {
	Components []Component `json:"components"`
	Snapshot   *Snapshot   `json:"snapshot"`
	Job        *Job        `json:"job"`
}

type StartRequest struct {
	ID       string   `json:"id"`
	Snapshot string   `json:"snapshot"`
	Targets  []string `json:"targets"`
}

func (r StartRequest) Validate() error {
	if !identifier.MatchString(r.ID) || !identifier.MatchString(r.Snapshot) || len(r.Targets) == 0 || len(r.Targets) > 64 {
		return errors.New("invalid update selection")
	}
	seen := make(map[string]bool, len(r.Targets))
	for _, target := range r.Targets {
		if !identifier.MatchString(target) || seen[target] {
			return errors.New("invalid or duplicate component selection")
		}
		seen[target] = true
	}
	return nil
}

type Target interface {
	Info(context.Context) Component
	Stage(context.Context, string, Package) error
	Apply(context.Context, string) error
	Status(context.Context, string) (Result, error)
	Cancel(context.Context, string) error
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func save(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".update-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(f.Name(), path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func read(path string, v any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxMetadata+1))
	if err != nil {
		return err
	}
	if len(b) > maxMetadata {
		return errors.New("update state too large")
	}
	return json.Unmarshal(b, v)
}

func readReservation(dir string) (string, error) {
	file, err := os.Open(filepath.Join(dir, "reservation"))
	if err != nil {
		return "", err
	}
	defer file.Close()
	id, err := io.ReadAll(io.LimitReader(file, 81))
	if err != nil {
		return "", err
	}
	if !identifier.Match(id) {
		return "", errors.New("invalid update reservation")
	}
	return string(id), nil
}
