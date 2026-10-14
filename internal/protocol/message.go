package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
)

// Message is the method set of client.Message and server.Message.
type Message interface {
	// WireType is the value of the type field, such as "auth:success".
	WireType() string
	// Validate checks the constraints of the Zod schema.
	Validate() error
}

// Decode errors. Match them with errors.Is.
var (
	ErrNotObject   = errors.New("message is not a JSON object")
	ErrNoType      = errors.New("message has no string type field")
	ErrUnknownType = errors.New("unknown message type")
	ErrInvalid     = errors.New("invalid message")
)

// Registry maps a wire type to a constructor of its empty struct.
type Registry[M Message] map[string]func() M

// Merge joins group maps into one registry. It panics on a type that two
// groups both claim, so a clash fails at startup and in every test.
func Merge[M Message](groups ...map[string]func() M) Registry[M] {
	out := Registry[M]{}
	for _, group := range groups {
		for wireType, build := range group {
			if _, dup := out[wireType]; dup {
				panic("protocol: wire type registered twice: " + wireType)
			}
			out[wireType] = build
		}
	}
	return out
}

// Types lists the registered wire types, sorted.
func (r Registry[M]) Types() []string {
	return slices.Sorted(maps.Keys(r))
}

// New returns an empty message of the given wire type.
func (r Registry[M]) New(wireType string) (M, bool) {
	build, ok := r[wireType]
	if !ok {
		var zero M
		return zero, false
	}
	return build(), true
}

// Decode reads one JSON message. It looks up the type, checks that required
// keys are present and not null, unmarshals into the registered struct and
// runs Validate. Unknown keys are ignored, as Zod strips them.
func Decode[M Message](data []byte, registry Registry[M]) (M, error) {
	var zero M
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return zero, ErrNotObject
	}
	var typeField *string
	if raw, ok := fields["type"]; !ok || json.Unmarshal(raw, &typeField) != nil || typeField == nil {
		return zero, ErrNoType
	}
	wireType := *typeField
	msg, ok := registry.New(wireType)
	if !ok {
		return zero, fmt.Errorf("%w: %q", ErrUnknownType, wireType)
	}
	if err := checkObject(fields, msg); err != nil {
		return zero, fmt.Errorf("%w %s: %w", ErrInvalid, wireType, err)
	}
	if err := json.Unmarshal(data, msg); err != nil {
		return zero, fmt.Errorf("%w %s: %w", ErrInvalid, wireType, err)
	}
	if err := msg.Validate(); err != nil {
		return zero, fmt.Errorf("%w %s: %w", ErrInvalid, wireType, err)
	}
	return msg, nil
}

// Encode validates a message and marshals it. Sending code uses it so a
// message that the browser would reject never leaves the server.
//
// Encode keeps <, > and & as they are. json.Marshal would write each as a
// six byte \u escape. Terminal output, diffs and file content are full of
// them, and frames never end up inside HTML.
func Encode(msg Message) ([]byte, error) {
	if err := msg.Validate(); err != nil {
		return nil, fmt.Errorf("%w %s: %w", ErrInvalid, msg.WireType(), err)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(msg); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}
