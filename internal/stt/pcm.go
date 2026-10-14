// Package stt is the speech to text service behind tmuxde dictation. It
// listens on a unix socket only. GET /health answers the probe of the hub
// and each WebSocket on /v1/stream is one dictation: PCM16 audio in, text
// out. Decoding runs through a Transcriber, which the binary backs with
// Parakeet through sherpa-onnx. Tests back it with a fake.
//
// Nothing here writes audio or text to disk, and logs never hold either.
package stt

import (
	"encoding/binary"
	"errors"
)

// SampleRate is the sample rate of every model this service runs and of
// all audio it accepts.
const SampleRate = 16000

// ErrHalfSample is returned for an odd byte count, which cannot be whole
// samples.
var ErrHalfSample = errors.New("audio must be whole 16-bit samples")

// PCM16ToFloat32 converts signed 16-bit little endian mono PCM to floats
// in [-1, 1].
func PCM16ToFloat32(b []byte) ([]float32, error) {
	if len(b)%2 != 0 {
		return nil, ErrHalfSample
	}
	samples := make([]float32, len(b)/2)
	for i := range samples {
		samples[i] = float32(int16(binary.LittleEndian.Uint16(b[i*2:]))) / 32768
	}
	return samples, nil
}
