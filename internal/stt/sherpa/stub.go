//go:build !(sherpa && cgo)

package sherpa

import "errors"

// Built reports whether the binding is compiled in.
const Built = false

// ErrNotBuilt is returned by every constructor of a build without the
// binding.
var ErrNotBuilt = errors.New("speech engine not built in: build with CGO_ENABLED=1 and -tags sherpa against the sherpa-onnx C API")

// Recognizer is the stub of the offline recognizer.
type Recognizer struct{}

// NewRecognizer returns ErrNotBuilt.
func NewRecognizer(RecognizerConfig) (*Recognizer, error) { return nil, ErrNotBuilt }

// Decode returns ErrNotBuilt.
func (*Recognizer) Decode([]float32) (string, error) { return "", ErrNotBuilt }

// Close does nothing.
func (*Recognizer) Close() {}

// VAD is the stub of the voice activity detector.
type VAD struct{}

// NewVAD returns ErrNotBuilt.
func NewVAD(VADConfig) (*VAD, error) { return nil, ErrNotBuilt }

// AcceptWaveform does nothing.
func (*VAD) AcceptWaveform([]float32) {}

// Empty reports true.
func (*VAD) Empty() bool { return true }

// Front returns nothing.
func (*VAD) Front() (int, []float32) { return 0, nil }

// Pop does nothing.
func (*VAD) Pop() {}

// Flush does nothing.
func (*VAD) Flush() {}

// Close does nothing.
func (*VAD) Close() {}
