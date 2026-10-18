package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Sides of the protocol. They name the fixture directories.
const (
	ClientSide = "client"
	ServerSide = "server"
)

// SourceDir finds the TypeScript protocol dir ui/src/protocol by walking up
// from the working directory. It holds the Zod sources and fixtures.
// Go tests run in a package dir below the repository root, on the host and
// in server-dev, and both have ui/src/protocol at that root.
func SourceDir() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		candidate := filepath.Join(dir, "ui", "src", "protocol")
		if _, err := os.Stat(filepath.Join(candidate, "client-messages.ts")); err == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("ui/src/protocol not found above the working directory")
		}
		dir = parent
	}
}

// FixtureName is the file name of a wire type's fixture: every ":" becomes
// "." and ".json" is added.
func FixtureName(wireType string) string {
	return strings.ReplaceAll(wireType, ":", ".") + ".json"
}

// FixtureType is the wire type for a fixture file name.
func FixtureType(name string) string {
	return strings.ReplaceAll(strings.TrimSuffix(name, ".json"), ".", ":")
}

// LoadFixture reads the samples for one wire type. side is ClientSide or
// ServerSide. A fixture file is a JSON array of one or more messages.
func LoadFixture(side, wireType string) ([]json.RawMessage, error) {
	dir, err := SourceDir()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "fixtures", side, FixtureName(wireType))
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var samples []json.RawMessage
	if err := json.Unmarshal(data, &samples); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if len(samples) == 0 {
		return nil, fmt.Errorf("%s: no samples", path)
	}
	return samples, nil
}
