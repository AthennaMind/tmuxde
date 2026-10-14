package stt

import "testing"

const testRate = 100

// speech is loud everywhere except one quiet stretch [quietFrom, quietTo).
func speech(length, quietFrom, quietTo int) []float32 {
	samples := make([]float32, length)
	for i := range samples {
		if i < quietFrom || i >= quietTo {
			samples[i] = 0.5
		}
	}
	return samples
}

func TestChunkerHoldsAudioUntilAChunkIsFull(t *testing.T) {
	c := NewAudioChunker(testRate, 10)
	if ready := c.Push(speech(500, -1, -1)); len(ready) != 0 {
		t.Fatalf("got %d chunks, want none", len(ready))
	}
	if rest := c.Flush(); len(rest) != 500 {
		t.Fatalf("flush got %d samples, want 500", len(rest))
	}
	if rest := c.Flush(); rest != nil {
		t.Fatalf("second flush got %d samples, want nil", len(rest))
	}
}

func TestChunkerCutsAtTheQuietestPauseNearTheEnd(t *testing.T) {
	c := NewAudioChunker(testRate, 10)
	// A 10 s chunk at 100 Hz is 1000 samples. Pause at 7.5 s to 7.8 s.
	ready := c.Push(speech(1200, 750, 780))
	if len(ready) != 1 {
		t.Fatalf("got %d chunks, want 1", len(ready))
	}
	cut := len(ready[0])
	if cut < 750 || cut > 780 {
		t.Fatalf("cut at %d, want within the pause 750 to 780", cut)
	}
	// Nothing lost at the cut.
	if total := cut + len(c.Flush()); total != 1200 {
		t.Fatalf("total %d, want 1200", total)
	}
}

func TestChunkerKeepsEveryChunkWithinTheLimit(t *testing.T) {
	c := NewAudioChunker(testRate, 10)
	ready := c.Push(speech(3500, -1, -1))
	if len(ready) < 3 {
		t.Fatalf("got %d chunks, want at least 3", len(ready))
	}
	total := 0
	for _, chunk := range ready {
		if len(chunk) > 1000 {
			t.Fatalf("chunk of %d samples, want at most 1000", len(chunk))
		}
		total += len(chunk)
	}
	total += len(c.Flush())
	if total != 3500 {
		t.Fatalf("total %d, want 3500", total)
	}
}

func TestChunkerNeverRewritesAChunkItHandedOut(t *testing.T) {
	c := NewAudioChunker(testRate, 10)
	ready := c.Push(speech(1200, 750, 780))
	before := append([]float32(nil), ready[0]...)
	c.Push(make([]float32, 2000))
	for i := range before {
		if ready[0][i] != before[i] {
			t.Fatalf("sample %d changed from %v to %v", i, before[i], ready[0][i])
		}
	}
}
