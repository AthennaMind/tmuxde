package stt

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Transcriber turns one buffer of 16 kHz mono samples into text. The text
// is empty for silence.
type Transcriber interface {
	Transcribe(samples []float32) (string, error)
}

// Model file names in STT_MODEL_DIR.
const (
	EncoderFile = "encoder.int8.onnx"
	DecoderFile = "decoder.int8.onnx"
	JoinerFile  = "joiner.int8.onnx"
	TokensFile  = "tokens.txt"
)

// ModelFiles are the files Parakeet needs in the model directory.
var ModelFiles = []string{EncoderFile, DecoderFile, JoinerFile, TokensFile}

// CheckModelFiles fails with every model file missing in dir, and the
// command that fetches them.
func CheckModelFiles(dir string) error {
	var missing []string
	for _, name := range ModelFiles {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("model files missing in %s: %s, run scripts/setup.sh --dictation", dir, strings.Join(missing, ", "))
	}
	return nil
}

// Serialize runs one decode at a time, in arrival order.
//
// Each decode already uses every thread it was given. Two at once would
// only split those threads and make both slower, and a second person
// talking would push the first one's wait up for no gain. A failed decode
// does not hold up the next one.
func Serialize(decode func(samples []float32) (string, error)) Transcriber {
	tail := make(chan struct{})
	close(tail)
	return &serialized{decode: decode, tail: tail}
}

type serialized struct {
	decode func([]float32) (string, error)

	mu   sync.Mutex
	tail chan struct{} // closed when the last queued decode is done
}

// Transcribe waits for every earlier call, then decodes. Callers queue in
// the order they take the lock, as the promise chain of the Node service
// did.
func (s *serialized) Transcribe(samples []float32) (text string, err error) {
	s.mu.Lock()
	prev := s.tail
	done := make(chan struct{})
	s.tail = done
	s.mu.Unlock()

	<-prev
	defer close(done)
	defer func() {
		// A panic in one decode must not stop every later one.
		if r := recover(); r != nil {
			text, err = "", fmt.Errorf("decode panicked: %v", r)
		}
	}()
	return s.decode(samples)
}
