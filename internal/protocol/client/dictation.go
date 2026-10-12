package client

import (
	"errors"
	"log/slog"
	"regexp"

	"tmuxde/internal/protocol"
)

var dictationTypes = map[string]func() Message{
	"dictation:start":  func() Message { return &DictationStart{} },
	"dictation:audio":  func() Message { return &DictationAudio{} },
	"dictation:stop":   func() Message { return &DictationStop{} },
	"dictation:cancel": func() Message { return &DictationCancel{} },
}

// maxDictationPCM caps one base64 audio frame, as in the Zod schema.
const maxDictationPCM = 64 * 1024

// dictationPCM mirrors the Zod regex. It checks the base64 alphabet and
// padding only, not that the length is a multiple of four.
var dictationPCM = regexp.MustCompile(`^[A-Za-z0-9+/]*={0,2}$`)

// validDictationID mirrors DictationId: 1 to 64 characters, picked by the
// client.
func validDictationID(id string) error {
	return protocol.LengthBetween("id", id, 1, 64)
}

// DictationStart opens a speech session. A second start cancels the first.
// Offered only when auth:success features has "dictation".
type DictationStart struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (*DictationStart) WireType() string { return "dictation:start" }

func (m *DictationStart) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "dictation:start"),
		validDictationID(m.ID),
	)
}

// DictationAudio is one audio frame for a running dictation. PCM is 16 kHz
// mono, signed 16-bit little endian, base64. It stays a string so the
// check matches Zod exactly. Decode it where the audio is used.
type DictationAudio struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	PCM  string `json:"pcm"`
}

func (*DictationAudio) WireType() string { return "dictation:audio" }

func (m *DictationAudio) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "dictation:audio"),
		validDictationID(m.ID),
		protocol.MaxLength("pcm", m.PCM, maxDictationPCM),
		protocol.Pattern("pcm", m.PCM, dictationPCM),
	)
}

// LogValue keeps recorded speech out of logs. It logs the frame size only.
func (m *DictationAudio) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("type", m.Type),
		slog.String("id", m.ID),
		slog.Int("pcm", len(m.PCM)),
	)
}

// DictationStop ends the audio. The rest is transcribed, then the server
// sends dictation:done.
type DictationStop struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (*DictationStop) WireType() string { return "dictation:stop" }

func (m *DictationStop) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "dictation:stop"),
		validDictationID(m.ID),
	)
}

// DictationCancel drops the session. Text not yet sent is discarded.
type DictationCancel struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (*DictationCancel) WireType() string { return "dictation:cancel" }

func (m *DictationCancel) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "dictation:cancel"),
		validDictationID(m.ID),
	)
}
