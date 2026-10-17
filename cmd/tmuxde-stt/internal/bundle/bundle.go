// Package bundle unpacks release models into a verified local cache.
// Downloads happen during builds. Runtime has no download path.
package bundle

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// Available reports whether this build embeds speech models.
func Available() bool { return assets() != nil }

// Extract returns a directory containing bundled Parakeet and Silero models.
func Extract() (string, error) {
	if !Available() {
		return "", errors.New("speech models are not bundled in this build")
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return materialize(assets(), filepath.Join(cache, "tmuxde-stt"))
}

func materialize(source fs.FS, cache string) (string, error) {
	manifest, err := fs.ReadFile(source, "manifest.json")
	if err != nil {
		return "", err
	}
	var files map[string]string
	if err := json.Unmarshal(manifest, &files); err != nil {
		return "", err
	}
	if len(files) == 0 {
		return "", errors.New("empty model manifest")
	}
	for name, hash := range files {
		digest, err := hex.DecodeString(hash)
		if !fs.ValidPath(name) || filepath.Base(name) != name || err != nil || len(digest) != sha256.Size {
			return "", fmt.Errorf("invalid model manifest entry %q", name)
		}
	}
	directory := filepath.Join(cache, fmt.Sprintf("%x", sha256.Sum256(manifest)))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	for name, hash := range files {
		path := filepath.Join(directory, name)
		if matches(path, hash) {
			continue
		}
		if err := extract(source, name, directory, hash); err != nil {
			return "", err
		}
	}
	return directory, nil
}

func matches(path, expected string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return false
	}
	return hex.EncodeToString(hash.Sum(nil)) == expected
}

func extract(source fs.FS, name, directory, expected string) error {
	input, err := source.Open(name)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.CreateTemp(directory, ".model-*")
	if err != nil {
		return err
	}
	temporary := output.Name()
	defer os.Remove(temporary)
	hash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(output, hash), input)
	closeErr := output.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != expected {
		return fmt.Errorf("bundled model checksum mismatch: %s", name)
	}
	// Atomic replacement also permits concurrent starts and repairs damaged caches.
	return os.Rename(temporary, filepath.Join(directory, name))
}
