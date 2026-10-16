// Package machine owns registered agents and their outbound connections.
package machine

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"
)

// Record is persisted without plaintext credentials.
type Record struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Hash    string    `json:"hash"`
	Created time.Time `json:"created"`
	Revoked bool      `json:"revoked"`
}

// Info is safe to expose to an authenticated browser.
type Info struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Online      bool     `json:"online"`
	Hostname    string   `json:"hostname"`
	Platform    string   `json:"platform"`
	DefaultPath string   `json:"defaultPath"`
	Version     string   `json:"version"`
	Features    []string `json:"features"`
}

func secret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func tokenHash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// Records reads current state. Every admission reads again so revocations apply.
func Records(dir string) ([]Record, error) {
	b, err := os.ReadFile(filepath.Join(dir, "machines.json"))
	if errors.Is(err, os.ErrNotExist) {
		return []Record{}, nil
	}
	if err != nil {
		return nil, err
	}
	var records []Record
	if err := json.Unmarshal(b, &records); err != nil {
		return nil, err
	}
	return records, nil
}

// Edit serializes CLI changes and writes state atomically.
func Edit(dir, operation, value string) (Record, string, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return Record{}, "", err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "machines.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return Record{}, "", err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return Record{}, "", err
	}
	defer func() { _ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) }()
	records, err := Records(dir)
	if err != nil {
		return Record{}, "", err
	}
	var result Record
	var token string
	switch operation {
	case "add":
		value = strings.TrimSpace(value)
		if value == "" || len(value) > 128 {
			return result, "", errors.New("machine name must contain 1 to 128 bytes")
		}
		token = secret()
		result = Record{
			ID:      secret()[:24],
			Name:    value,
			Hash:    tokenHash(token),
			Created: time.Now().UTC(),
		}
		records = append(records, result)
	case "revoke", "rotate":
		i := slices.IndexFunc(records, func(r Record) bool { return r.ID == value })
		if i < 0 {
			return result, "", errors.New("machine not found")
		}
		if operation == "revoke" {
			records[i].Revoked = true
		} else {
			token = secret()
			records[i].Hash = tokenHash(token)
			records[i].Revoked = false
		}
		result = records[i]
	default:
		return result, "", errors.New("unknown machine operation")
	}
	b, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return result, "", err
	}
	f, err := os.CreateTemp(dir, ".machines-*")
	if err != nil {
		return result, "", err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), filepath.Join(dir, "machines.json"))
	}
	return result, token, err
}
