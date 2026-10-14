package stt

import (
	"fmt"
	"os"
)

// Segmenter cuts a stream of audio into pieces that are each decoded on
// their own.
//
// Push returns pieces that are complete. Flush returns the rest at the end
// of a dictation. Close frees what the segmenter holds. A session calls
// all three from one goroutine.
type Segmenter interface {
	Push(samples []float32) [][]float32
	Flush() [][]float32
	Close()
}

// chunkSegmenter cuts fixed chunks of up to 30 s at the quietest moment
// near their end.
type chunkSegmenter struct {
	chunker *AudioChunker
}

// NewChunkSegmenter returns the segmenter used without a VAD model.
func NewChunkSegmenter() Segmenter {
	return &chunkSegmenter{chunker: NewAudioChunker(SampleRate, ChunkSeconds)}
}

func (s *chunkSegmenter) Push(samples []float32) [][]float32 {
	return s.chunker.Push(samples)
}

func (s *chunkSegmenter) Flush() [][]float32 {
	if rest := s.chunker.Flush(); rest != nil {
		return [][]float32{rest}
	}
	return nil
}

func (s *chunkSegmenter) Close() {}

// VADWindow is the input window of Silero: 32 ms at 16 kHz.
const VADWindow = 512

// preroll is audio kept from before each utterance. Silero marks speech a
// little after it starts, and a soft first sound ("С", "f", "h") falls off
// the front: "Сплавите" came back as "Плавете".
const preroll = SampleRate * 3 / 10

// historySamples is the length of the history ring. An utterance is only
// handed over once it ends, up to 25 s after it began, so the ring has to
// reach back further than that.
const historySamples = 30 * SampleRate

// AudioHistory holds the last 30 s of audio, addressed by absolute sample
// index.
type AudioHistory struct {
	ring []float32
	// Written counts samples written so far. It is the absolute index of
	// the next one.
	Written int
}

// NewAudioHistory returns an empty history.
func NewAudioHistory() *AudioHistory {
	return &AudioHistory{ring: make([]float32, historySamples)}
}

// Write appends samples.
func (h *AudioHistory) Write(samples []float32) {
	for i, s := range samples {
		h.ring[(h.Written+i)%historySamples] = s
	}
	h.Written += len(samples)
}

// Read returns a copy of samples [from, to), clipped to what is still
// held.
func (h *AudioHistory) Read(from, to int) []float32 {
	start := max(from, h.Written-historySamples, 0)
	end := min(to, h.Written)
	out := make([]float32, max(0, end-start))
	for i := range out {
		out[i] = h.ring[(start+i)%historySamples]
	}
	return out
}

// VAD is a voice activity detector, Silero through sherpa-onnx in the
// binary. It queues each finished utterance as a segment.
type VAD interface {
	// AcceptWaveform feeds samples, VADWindow at a time.
	AcceptWaveform(samples []float32)
	// Empty reports whether no finished segment is queued.
	Empty() bool
	// Front returns the first queued segment: its absolute start index and
	// a copy of its samples that the caller owns.
	Front() (start int, samples []float32)
	// Pop drops the first queued segment.
	Pop()
	// Flush ends the current utterance, if any, and queues it.
	Flush()
	// Close frees the detector.
	Close()
}

// VADSegmenter returns one piece per utterance, cut where the speaker
// pauses.
//
// This is why there is a VAD at all. Parakeet picks one language per
// decode, so a buffer holding an English sentence and a Bulgarian one
// comes back in one language with the other sentence gone. Decoded one
// utterance at a time, each sentence keeps its own language. Text also
// arrives after every pause rather than every 30 s, and silence is never
// decoded, so the model cannot invent words for it.
type VADSegmenter struct {
	vad     VAD
	history *AudioHistory
	pending []float32
	// lastEnd is where the last utterance ended, so pre-roll never
	// repeats it.
	lastEnd int
}

// NewVADSegmenter returns a segmenter over vad. It owns vad and closes it
// in Close.
func NewVADSegmenter(vad VAD) *VADSegmenter {
	return &VADSegmenter{vad: vad, history: NewAudioHistory()}
}

// LoadVADSegmenter checks the Silero model at modelPath and returns a
// factory for one segmenter per session. open creates a detector for the
// model. One detector is opened and closed here, so a broken model fails
// at startup, not on someone's first word.
func LoadVADSegmenter(modelPath string, open func(modelPath string) (VAD, error)) (func() (Segmenter, error), error) {
	if _, err := os.Stat(modelPath); err != nil {
		return nil, fmt.Errorf("VAD model missing at %s. Run scripts/setup.sh --dictation.", modelPath)
	}
	vad, err := open(modelPath)
	if err != nil {
		return nil, err
	}
	vad.Close()
	return func() (Segmenter, error) {
		vad, err := open(modelPath)
		if err != nil {
			return nil, err
		}
		return NewVADSegmenter(vad), nil
	}, nil
}

func (s *VADSegmenter) accept(window []float32) {
	s.history.Write(window)
	s.vad.AcceptWaveform(window)
}

func (s *VADSegmenter) drain() [][]float32 {
	var out [][]float32
	for !s.vad.Empty() {
		// Front copies the samples, so they stay valid after Pop.
		start, samples := s.vad.Front()
		s.vad.Pop()
		before := s.history.Read(max(start-preroll, s.lastEnd), start)
		segment := make([]float32, 0, len(before)+len(samples))
		segment = append(segment, before...)
		segment = append(segment, samples...)
		s.lastEnd = start + len(samples)
		out = append(out, bounded(segment)...)
	}
	return out
}

// Push feeds whole windows to the detector and keeps the remainder for
// the next call.
func (s *VADSegmenter) Push(samples []float32) [][]float32 {
	all := append(s.pending, samples...)
	offset := 0
	for ; offset+VADWindow <= len(all); offset += VADWindow {
		s.accept(all[offset : offset+VADWindow])
	}
	s.pending = append([]float32(nil), all[offset:]...)
	return s.drain()
}

// Flush pads the remainder to a whole window, feeds it and ends the
// current utterance.
func (s *VADSegmenter) Flush() [][]float32 {
	if len(s.pending) > 0 {
		last := make([]float32, VADWindow)
		copy(last, s.pending)
		s.accept(last)
		s.pending = nil
	}
	s.vad.Flush()
	return s.drain()
}

// Close frees the detector.
func (s *VADSegmenter) Close() {
	s.vad.Close()
}

// bounded splits a segment longer than 30 s. The VAD caps utterances at
// 25 s, and the model is never handed more than 30.
func bounded(segment []float32) [][]float32 {
	if len(segment) <= ChunkSeconds*SampleRate {
		return [][]float32{segment}
	}
	chunker := NewAudioChunker(SampleRate, ChunkSeconds)
	pieces := chunker.Push(segment)
	if rest := chunker.Flush(); rest != nil {
		pieces = append(pieces, rest)
	}
	return pieces
}
