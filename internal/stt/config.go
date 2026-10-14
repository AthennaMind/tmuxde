package stt

import (
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"strconv"
	"strings"
)

// maxSocketPath is the longest unix socket path Linux takes. sun_path
// holds 108 bytes, the last one for the closing NUL.
const maxSocketPath = 107

// Config is the validated service configuration. Names and bounds match
// the Node service it replaces.
type Config struct {
	// Socket is the unix socket the service listens on. The tmuxde server
	// dials it, and the container health check uses it too. There is no
	// TCP listener. STT_SOCKET, required.
	Socket string
	// ModelDir holds encoder, decoder, joiner and tokens of the model.
	// STT_MODEL_DIR, required.
	ModelDir string
	// VADModel is the Silero VAD model. With it, audio is decoded one
	// utterance at a time. Without it, in chunks of up to 30 s.
	// STT_VAD_MODEL, optional.
	VADModel string
	// Threads per decode. STT_THREADS, 1 to 64, default 4.
	Threads int
	// MaxSessions is the number of dictations at once. Each one is a
	// person talking. STT_MAX_SESSIONS, 1 to 64, default 4.
	MaxSessions int
	// MaxSeconds is the audio one session may send before it is stopped.
	// STT_MAX_SECONDS, 10 to 3600, default 600.
	MaxSeconds int
}

// ConfigError is one invalid setting.
type ConfigError struct {
	Var    string
	Reason string
}

func (e *ConfigError) Error() string {
	return e.Var + ": " + e.Reason
}

// LoadConfig reads and validates every setting through lookup. It reports
// all invalid settings at once, joined.
func LoadConfig(lookup func(string) (string, bool)) (Config, error) {
	get := func(name string) string {
		v, _ := lookup(name)
		return v
	}
	var cfg Config
	var errs []error
	fail := func(name, reason string) {
		errs = append(errs, &ConfigError{name, reason})
	}

	switch cfg.Socket = get("STT_SOCKET"); {
	case cfg.Socket == "":
		fail("STT_SOCKET", "is required")
	case !filepath.IsAbs(cfg.Socket):
		fail("STT_SOCKET", "must be an absolute path")
	case len(cfg.Socket) > maxSocketPath:
		fail("STT_SOCKET", fmt.Sprintf("must be at most %d bytes", maxSocketPath))
	}

	if cfg.ModelDir = get("STT_MODEL_DIR"); cfg.ModelDir == "" {
		fail("STT_MODEL_DIR", "is required")
	}
	cfg.VADModel = get("STT_VAD_MODEL")

	number := func(name string, lo, hi, def int) int {
		raw := get(name)
		if raw == "" {
			return def
		}
		// Zod coerced with Number(), which allows surrounding space and
		// forms like 1e1.
		f, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		switch {
		case err != nil:
			fail(name, "must be a number")
		case f != math.Trunc(f):
			fail(name, "must be an integer")
		case f < float64(lo) || f > float64(hi):
			fail(name, fmt.Sprintf("must be between %d and %d", lo, hi))
		default:
			return int(f)
		}
		return def
	}
	cfg.Threads = number("STT_THREADS", 1, 64, 4)
	cfg.MaxSessions = number("STT_MAX_SESSIONS", 1, 64, 4)
	cfg.MaxSeconds = number("STT_MAX_SECONDS", 10, 3600, 600)

	if len(errs) > 0 {
		return Config{}, errors.Join(errs...)
	}
	return cfg, nil
}
