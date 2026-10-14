// Adapted from Orca src/main/speech/stt-offline-audio-chunker.ts.
// MIT License, Copyright (c) 2026 Lovecast Inc.

package stt

import "math"

// ChunkSeconds is the longest buffer decoded in one call.
//
// Parakeet is an offline model and decodes a whole buffer at once. Memory
// grows with buffer length, so long dictation is decoded in bounded
// chunks. Each chunk also turns into text while the user is still talking.
const ChunkSeconds = 30

// A cut in the middle of a word hurts recognition on both sides of it. The
// quietest 100 ms in the last 5 s of a chunk is almost always a pause
// between words. Shorter windows match the silence inside a plosive and
// cut mid word.
const (
	splitSearchSeconds = 5
	splitWindowSeconds = 0.1
)

// AudioChunker buffers audio and cuts it into chunks of at most
// chunkSeconds, each cut at the quietest moment near its end.
type AudioChunker struct {
	buffered []float32
	limit    int
	search   int
	window   int
}

// NewAudioChunker returns a chunker for audio at sampleRate.
func NewAudioChunker(sampleRate int, chunkSeconds float64) *AudioChunker {
	return &AudioChunker{
		limit:  max(1, int(math.Round(chunkSeconds*float64(sampleRate)))),
		search: int(math.Round(splitSearchSeconds * float64(sampleRate))),
		window: max(1, int(math.Round(splitWindowSeconds*float64(sampleRate)))),
	}
}

// Push buffers a copy of samples. It returns the chunks that are full and
// ready to decode.
func (c *AudioChunker) Push(samples []float32) [][]float32 {
	if len(samples) == 0 {
		return nil
	}
	c.buffered = append(c.buffered, samples...)

	var ready [][]float32
	for len(c.buffered) >= c.limit {
		split := c.quietSplit(c.buffered)
		// The chunk keeps its own backing array. The tail is copied, so
		// later pushes never write into a chunk already handed out.
		ready = append(ready, c.buffered[:split:split])
		c.buffered = append([]float32(nil), c.buffered[split:]...)
	}
	return ready
}

// Flush returns everything still buffered, always shorter than one
// chunk. It returns nil when nothing is buffered.
func (c *AudioChunker) Flush() []float32 {
	if len(c.buffered) == 0 {
		return nil
	}
	rest := c.buffered
	c.buffered = nil
	return rest
}

func (c *AudioChunker) quietSplit(samples []float32) int {
	limit := min(c.limit, len(samples))
	start := max(0, limit-c.search)
	hop := max(1, c.window/2)
	best := limit
	bestEnergy := math.Inf(1)
	for from := start; from+c.window <= limit; from += hop {
		energy := 0.0
		for _, s := range samples[from : from+c.window] {
			energy += float64(s) * float64(s)
		}
		if energy < bestEnergy {
			bestEnergy = energy
			best = from + c.window/2
		}
	}
	// A split must consume at least one sample, or Push never ends.
	return max(1, best)
}
