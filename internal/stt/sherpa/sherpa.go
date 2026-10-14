//go:build sherpa && cgo

// Package sherpa binds the parts of the sherpa-onnx C API the speech
// service uses: the offline recognizer for Parakeet TDT and the Silero
// voice activity detector. Only this package imports "C".
//
// Headers and libraries come from the sherpa-onnx release tarball. The
// image passes their directories in CGO_CFLAGS and CGO_LDFLAGS and builds
// with -tags sherpa. Every other build gets stub.go.
//
// Every config struct starts zeroed, so fields the service does not set
// keep the defaults of the C API.
package sherpa

/*
#cgo LDFLAGS: -lsherpa-onnx-c-api -lonnxruntime
#include <stdlib.h>
#include <string.h>
#include "sherpa-onnx/c-api/c-api.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"strings"
	"unsafe"
)

// Built reports whether the binding is compiled in.
const Built = true

// cstrings holds C copies of Go strings until free.
type cstrings []*C.char

func (c *cstrings) add(s string) *C.char {
	p := C.CString(s)
	*c = append(*c, p)
	return p
}

func (c cstrings) free() {
	for _, p := range c {
		C.free(unsafe.Pointer(p))
	}
}

// Recognizer is an offline recognizer for one transducer model. Decode
// is not safe for concurrent use. The service serializes it.
type Recognizer struct {
	p          *C.SherpaOnnxOfflineRecognizer
	sampleRate int
}

// NewRecognizer loads the model. Loading takes a few seconds.
func NewRecognizer(cfg RecognizerConfig) (*Recognizer, error) {
	var strs cstrings
	defer strs.free()

	var c C.SherpaOnnxOfflineRecognizerConfig
	C.memset(unsafe.Pointer(&c), 0, C.sizeof_SherpaOnnxOfflineRecognizerConfig)
	c.feat_config.sample_rate = C.int32_t(cfg.SampleRate)
	c.feat_config.feature_dim = featureDim
	c.model_config.transducer.encoder = strs.add(cfg.Encoder)
	c.model_config.transducer.decoder = strs.add(cfg.Decoder)
	c.model_config.transducer.joiner = strs.add(cfg.Joiner)
	c.model_config.tokens = strs.add(cfg.Tokens)
	c.model_config.num_threads = C.int32_t(cfg.Threads)
	c.model_config.provider = strs.add(provider)
	c.model_config.debug = 0
	c.decoding_method = strs.add(decodingMethod)

	p := C.SherpaOnnxCreateOfflineRecognizer(&c)
	if p == nil {
		return nil, fmt.Errorf("sherpa-onnx refused the model in %s", cfg.Encoder)
	}
	return &Recognizer{p: p, sampleRate: cfg.SampleRate}, nil
}

// Decode returns the text of one buffer of mono samples, trimmed. Offline
// streams are single use, so each call makes a fresh one.
func (r *Recognizer) Decode(samples []float32) (string, error) {
	if r.p == nil {
		return "", errors.New("recognizer is closed")
	}
	stream := C.SherpaOnnxCreateOfflineStream(r.p)
	if stream == nil {
		return "", errors.New("sherpa-onnx could not create a stream")
	}
	defer C.SherpaOnnxDestroyOfflineStream(stream)
	if len(samples) > 0 {
		C.SherpaOnnxAcceptWaveformOffline(stream, C.int32_t(r.sampleRate),
			(*C.float)(unsafe.Pointer(&samples[0])), C.int32_t(len(samples)))
	}
	C.SherpaOnnxDecodeOfflineStream(r.p, stream)
	result := C.SherpaOnnxGetOfflineStreamResult(stream)
	if result == nil {
		return "", errors.New("sherpa-onnx returned no result")
	}
	defer C.SherpaOnnxDestroyOfflineRecognizerResult(result)
	if result.text == nil {
		return "", nil
	}
	return strings.TrimSpace(C.GoString(result.text)), nil
}

// Close frees the recognizer.
func (r *Recognizer) Close() {
	if r.p != nil {
		C.SherpaOnnxDestroyOfflineRecognizer(r.p)
		r.p = nil
	}
}

// VAD is a Silero voice activity detector. It is not safe for concurrent
// use. Each session owns one.
type VAD struct {
	p *C.SherpaOnnxVoiceActivityDetector
}

// NewVAD opens a detector for the Silero model at cfg.Model.
func NewVAD(cfg VADConfig) (*VAD, error) {
	var strs cstrings
	defer strs.free()

	var c C.SherpaOnnxVadModelConfig
	C.memset(unsafe.Pointer(&c), 0, C.sizeof_SherpaOnnxVadModelConfig)
	c.silero_vad.model = strs.add(cfg.Model)
	c.silero_vad.threshold = vadThreshold
	c.silero_vad.min_silence_duration = vadMinSilence
	c.silero_vad.min_speech_duration = vadMinSpeech
	c.silero_vad.window_size = vadWindow
	c.silero_vad.max_speech_duration = vadMaxSpeech
	c.sample_rate = C.int32_t(cfg.SampleRate)
	c.num_threads = 1
	c.provider = strs.add(provider)
	c.debug = 0

	p := C.SherpaOnnxCreateVoiceActivityDetector(&c, vadBufferSeconds)
	if p == nil {
		return nil, fmt.Errorf("sherpa-onnx refused the VAD model %s", cfg.Model)
	}
	return &VAD{p: p}, nil
}

// AcceptWaveform feeds samples.
func (v *VAD) AcceptWaveform(samples []float32) {
	if len(samples) == 0 {
		return
	}
	C.SherpaOnnxVoiceActivityDetectorAcceptWaveform(v.p,
		(*C.float)(unsafe.Pointer(&samples[0])), C.int32_t(len(samples)))
}

// Empty reports whether no finished segment is queued.
func (v *VAD) Empty() bool {
	return C.SherpaOnnxVoiceActivityDetectorEmpty(v.p) != 0
}

// Front returns the first queued segment. The samples are copied out of C
// memory, so they stay valid after Pop.
func (v *VAD) Front() (int, []float32) {
	seg := C.SherpaOnnxVoiceActivityDetectorFront(v.p)
	if seg == nil {
		return 0, nil
	}
	defer C.SherpaOnnxDestroySpeechSegment(seg)
	samples := make([]float32, int(seg.n))
	if seg.n > 0 && seg.samples != nil {
		copy(samples, unsafe.Slice((*float32)(unsafe.Pointer(seg.samples)), int(seg.n)))
	}
	return int(seg.start), samples
}

// Pop drops the first queued segment.
func (v *VAD) Pop() {
	C.SherpaOnnxVoiceActivityDetectorPop(v.p)
}

// Flush ends the current utterance and queues it.
func (v *VAD) Flush() {
	C.SherpaOnnxVoiceActivityDetectorFlush(v.p)
}

// Close frees the detector.
func (v *VAD) Close() {
	if v.p != nil {
		C.SherpaOnnxDestroyVoiceActivityDetector(v.p)
		v.p = nil
	}
}
