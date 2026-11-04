// Package ready acknowledges native update startup without network access.
package ready

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

type Receipt struct {
	PID     int    `json:"pid"`
	Version string `json:"version"`
	Digest  string `json:"digest"`
}

// Mark writes a receipt only when this installation has a pending transaction.
// Call after listeners and local dependencies are ready, never before startup.
func Mark(version string) error {
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	dir := filepath.Join(filepath.Dir(binary), "."+filepath.Base(binary)+"-update")
	id, err := os.ReadFile(filepath.Join(dir, "reservation"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`).Match(id) {
		return nil
	}
	f, err := os.Open(binary)
	if err != nil {
		return err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return err
	}
	data, err := json.Marshal(Receipt{PID: os.Getpid(), Version: version, Digest: hex.EncodeToString(hash.Sum(nil))})
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".ready-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	_, err = temp.Write(data)
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temp.Name(), filepath.Join(dir, string(id)+".ready"))
}
