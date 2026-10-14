package dictation

import (
	"encoding/json"
	"errors"
	"fmt"

	"tmuxde/internal/protocol"
)

// Types of service messages. They mirror internal/stt/session.go.
const (
	sttReady = "ready"
	sttText  = "text"
	sttDone  = "done"
	sttError = "error"
)

// sttMessage is one checked message from the service.
type sttMessage struct {
	typ     string
	text    string
	code    string
	message string
}

// parseSTT checks a service message as the relay's Zod union did. The
// service is ours, but it is a separate process, and nothing it says
// reaches a browser unchecked. Keys match exactly and extra keys are
// allowed. A text over maxText UTF-16 code units fails.
func parseSTT(data []byte, maxText int) (sttMessage, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return sttMessage{}, fmt.Errorf("not a JSON object: %w", err)
	}
	if obj == nil {
		return sttMessage{}, errors.New("not a JSON object: null")
	}
	typ, err := field(obj, "type")
	if err != nil {
		return sttMessage{}, err
	}
	m := sttMessage{typ: typ}
	switch typ {
	case sttReady, sttDone:
	case sttText:
		if m.text, err = field(obj, "text"); err != nil {
			return sttMessage{}, err
		}
		if err := protocol.MaxLength("text", m.text, maxText); err != nil {
			return sttMessage{}, err
		}
	case sttError:
		if m.code, err = field(obj, "code"); err != nil {
			return sttMessage{}, err
		}
		if m.message, err = field(obj, "message"); err != nil {
			return sttMessage{}, err
		}
	default:
		return sttMessage{}, fmt.Errorf("type: unknown %q", typ)
	}
	return m, nil
}

// field reads a required string. JSON null is not a string.
func field(obj map[string]json.RawMessage, key string) (string, error) {
	raw, ok := obj[key]
	if !ok {
		return "", fmt.Errorf("%s: missing", key)
	}
	var s *string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", fmt.Errorf("%s: %w", key, err)
	}
	if s == nil {
		return "", fmt.Errorf("%s: null", key)
	}
	return *s, nil
}
