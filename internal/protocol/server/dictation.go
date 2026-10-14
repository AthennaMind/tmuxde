package server

import (
	"errors"
	"log/slog"

	"tmuxde/internal/protocol"
)

var dictationTypes = map[string]func() Message{
	"dictation:ready": func() Message { return &DictationReady{} },
	"dictation:text":  func() Message { return &DictationText{} },
	"dictation:done":  func() Message { return &DictationDone{} },
	"dictation:error": func() Message { return &DictationError{} },
}

// Codes of dictation:error. The schema takes any string, so Validate does
// not enforce them.
const (
	DictationUnavailable = "UNAVAILABLE" // no speech service
	DictationBusy        = "BUSY"        // service at capacity
	DictationOverloaded  = "OVERLOADED"  // audio faster than it can be forwarded
	DictationNotFound    = "NOT_FOUND"   // audio or stop for no running dictation
	DictationFailed      = "FAILED"
)

// validDictationID mirrors DictationId: 1 to 64 characters, picked by the
// client.
func validDictationID(id string) error {
	return protocol.LengthBetween("id", id, 1, 64)
}

// DictationReady says the speech service is listening. Audio sent from now
// on is transcribed.
type DictationReady struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (*DictationReady) WireType() string { return "dictation:ready" }

func (m *DictationReady) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "dictation:ready"),
		validDictationID(m.ID),
	)
}

// DictationText is the text of one utterance, in order. It has no
// separator. The client decides spacing between pieces.
type DictationText struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Text string `json:"text"`
}

func (*DictationText) WireType() string { return "dictation:text" }

func (m *DictationText) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "dictation:text"),
		validDictationID(m.ID),
		protocol.MaxLength("text", m.Text, 20_000),
	)
}

// LogValue keeps the transcript out of logs. It logs the text size only.
func (m *DictationText) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("type", m.Type),
		slog.String("id", m.ID),
		slog.Int("textLength", len(m.Text)),
	)
}

// DictationDone says everything after dictation:stop is transcribed.
// Nothing more follows.
type DictationDone struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (*DictationDone) WireType() string { return "dictation:done" }

func (m *DictationDone) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "dictation:done"),
		validDictationID(m.ID),
	)
}

// DictationError ends a dictation that did not finish. Nothing more
// follows. Message is safe to show.
type DictationError struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (*DictationError) WireType() string { return "dictation:error" }

func (m *DictationError) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "dictation:error"),
		validDictationID(m.ID),
	)
}
