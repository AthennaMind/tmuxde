package stt

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func ramp(from float32, length int) []float32 {
	out := make([]float32, length)
	for i := range out {
		out[i] = from + float32(i)
	}
	return out
}

func lengths(pieces [][]float32) []int {
	out := make([]int, len(pieces))
	for i, p := range pieces {
		out[i] = len(p)
	}
	return out
}

func TestHistoryReadsBackByAbsoluteIndex(t *testing.T) {
	h := NewAudioHistory()
	h.Write(ramp(0, 10))
	h.Write(ramp(10, 10))
	if got, want := h.Read(8, 12), []float32{8, 9, 10, 11}; !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestHistoryOnlyReturnsWhatItStillHolds(t *testing.T) {
	h := NewAudioHistory()
	h.Write(ramp(0, 30*SampleRate+100))
	if got := len(h.Read(0, 102)); got != 2 {
		t.Fatalf("old read got %d samples, want 2", got)
	}
	if got := len(h.Read(30*SampleRate+90, 30*SampleRate+200)); got != 10 {
		t.Fatalf("recent read got %d samples, want 10", got)
	}
}

func TestChunkSegmenterReturnsTheRemainderOnFlush(t *testing.T) {
	s := NewChunkSegmenter()
	if got := s.Push(make([]float32, SampleRate)); len(got) != 0 {
		t.Fatalf("push got %v, want nothing", lengths(got))
	}
	if got := lengths(s.Flush()); !slices.Equal(got, []int{SampleRate}) {
		t.Fatalf("flush got %v, want [%d]", got, SampleRate)
	}
	if got := s.Flush(); len(got) != 0 {
		t.Fatalf("second flush got %v, want nothing", lengths(got))
	}
}

// fakeVAD stores every sample it is fed and hands out the segments it was
// told about, each once enough audio has arrived to end it.
type fakeVAD struct {
	audio    []float32
	windows  []int
	segments [][2]int // [start, end) in absolute samples, in order
	flushed  bool
	closed   bool
}

func (v *fakeVAD) AcceptWaveform(samples []float32) {
	v.windows = append(v.windows, len(samples))
	v.audio = append(v.audio, samples...)
}

func (v *fakeVAD) ready() bool {
	return len(v.segments) > 0 && (v.flushed || v.segments[0][1] <= len(v.audio))
}

func (v *fakeVAD) Empty() bool { return !v.ready() }

func (v *fakeVAD) Front() (int, []float32) {
	seg := v.segments[0]
	end := min(seg[1], len(v.audio))
	return seg[0], append([]float32(nil), v.audio[seg[0]:end]...)
}

func (v *fakeVAD) Pop()   { v.segments = v.segments[1:] }
func (v *fakeVAD) Flush() { v.flushed = true }
func (v *fakeVAD) Close() { v.closed = true }

func TestVADSegmenterFeedsWholeWindows(t *testing.T) {
	vad := &fakeVAD{}
	s := NewVADSegmenter(vad)
	s.Push(make([]float32, 700))
	s.Push(make([]float32, 400))
	if want := []int{512, 512}; !slices.Equal(vad.windows, want) {
		t.Fatalf("windows %v, want %v", vad.windows, want)
	}
	// Flush pads the last 76 samples to a whole window.
	s.Flush()
	if want := []int{512, 512, 512}; !slices.Equal(vad.windows, want) {
		t.Fatalf("windows after flush %v, want %v", vad.windows, want)
	}
	if !vad.flushed {
		t.Fatal("flush did not reach the detector")
	}
	if tail := vad.audio[1100:]; slices.ContainsFunc(tail, func(f float32) bool { return f != 0 }) {
		t.Fatal("padding is not silence")
	}
}

func TestVADSegmenterAddsPreroll(t *testing.T) {
	vad := &fakeVAD{segments: [][2]int{{8000, 9000}}}
	s := NewVADSegmenter(vad)
	var pieces [][]float32
	for i := 0; i < 16; i++ {
		pieces = append(pieces, s.Push(ramp(float32(i*1000), 1000))...)
	}
	if len(pieces) != 1 {
		t.Fatalf("got %d pieces, want 1", len(pieces))
	}
	p := pieces[0]
	if len(p) != preroll+1000 {
		t.Fatalf("piece of %d samples, want %d", len(p), preroll+1000)
	}
	if p[0] != 8000-preroll || p[len(p)-1] != 8999 {
		t.Fatalf("piece runs %v to %v, want %v to 8999", p[0], p[len(p)-1], 8000-preroll)
	}
}

func TestVADSegmenterPrerollNeverRepeatsTheLastUtterance(t *testing.T) {
	vad := &fakeVAD{segments: [][2]int{{1000, 2000}, {2500, 3000}}}
	s := NewVADSegmenter(vad)
	pieces := s.Push(ramp(0, 4096))
	if got, want := lengths(pieces), []int{2000, 1000}; !slices.Equal(got, want) {
		t.Fatalf("pieces %v, want %v", got, want)
	}
	if pieces[1][0] != 2000 {
		t.Fatalf("second piece starts at %v, want 2000", pieces[1][0])
	}
}

func TestVADSegmenterFlushReturnsTheOpenUtterance(t *testing.T) {
	vad := &fakeVAD{segments: [][2]int{{100, 1_000_000}}}
	s := NewVADSegmenter(vad)
	if got := s.Push(ramp(0, 1100)); len(got) != 0 {
		t.Fatalf("push got %v, want nothing before the end", lengths(got))
	}
	pieces := s.Flush()
	// 100 samples of pre-roll, then everything fed: 1100 plus the padding.
	if got, want := lengths(pieces), []int{1536}; !slices.Equal(got, want) {
		t.Fatalf("pieces %v, want %v", got, want)
	}
}

func TestVADSegmenterBoundsLongUtterances(t *testing.T) {
	long := 35 * SampleRate
	vad := &fakeVAD{segments: [][2]int{{0, long}}}
	s := NewVADSegmenter(vad)
	pieces := s.Push(make([]float32, long+VADWindow))
	if len(pieces) != 2 {
		t.Fatalf("got %d pieces, want 2", len(pieces))
	}
	total := 0
	for _, p := range pieces {
		if len(p) > ChunkSeconds*SampleRate {
			t.Fatalf("piece of %d samples, want at most %d", len(p), ChunkSeconds*SampleRate)
		}
		total += len(p)
	}
	if total != long {
		t.Fatalf("total %d, want %d", total, long)
	}
}

func TestVADSegmenterClosesTheDetector(t *testing.T) {
	vad := &fakeVAD{}
	NewVADSegmenter(vad).Close()
	if !vad.closed {
		t.Fatal("detector not closed")
	}
}

func TestLoadVADSegmenter(t *testing.T) {
	t.Run("missing model", func(t *testing.T) {
		_, err := LoadVADSegmenter("/nonexistent/silero_vad.onnx", func(string) (VAD, error) {
			t.Fatal("opened a missing model")
			return nil, nil
		})
		if err == nil || !strings.Contains(err.Error(), "VAD model missing at /nonexistent/silero_vad.onnx") {
			t.Fatalf("err = %v", err)
		}
	})

	model := filepath.Join(t.TempDir(), "silero_vad.onnx")
	if err := os.WriteFile(model, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("broken model fails at load", func(t *testing.T) {
		broken := errors.New("refused")
		_, err := LoadVADSegmenter(model, func(string) (VAD, error) { return nil, broken })
		if !errors.Is(err, broken) {
			t.Fatalf("err = %v, want %v", err, broken)
		}
	})

	t.Run("one detector per session", func(t *testing.T) {
		var opened []*fakeVAD
		factory, err := LoadVADSegmenter(model, func(path string) (VAD, error) {
			if path != model {
				t.Fatalf("opened %s, want %s", path, model)
			}
			v := &fakeVAD{}
			opened = append(opened, v)
			return v, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(opened) != 1 || !opened[0].closed {
			t.Fatal("load did not open and close one detector")
		}
		a, _ := factory()
		b, _ := factory()
		if len(opened) != 3 || a == b {
			t.Fatalf("opened %d detectors, want a fresh one per session", len(opened))
		}
		a.Close()
		if !opened[1].closed || opened[2].closed {
			t.Fatal("Close closed the wrong detector")
		}
	})
}
