package stt

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSerializeRunsOneDecodeAtATimeInArrivalOrder(t *testing.T) {
	var running atomic.Int32
	var mu sync.Mutex
	var order []string
	note := func(s string) {
		mu.Lock()
		order = append(order, s)
		mu.Unlock()
	}
	tr := Serialize(func(samples []float32) (string, error) {
		if n := running.Add(1); n != 1 {
			t.Errorf("%d decodes at once", n)
		}
		note(fmt.Sprintf("start %d", len(samples)))
		time.Sleep(5 * time.Millisecond)
		note(fmt.Sprintf("end %d", len(samples)))
		running.Add(-1)
		return "", nil
	})

	// tail changes once a caller has taken its place in the queue.
	s := tr.(*serialized)
	tail := func() chan struct{} {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.tail
	}
	var wg sync.WaitGroup
	for n := 1; n <= 3; n++ {
		before := tail()
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = tr.Transcribe(make([]float32, n))
		}()
		for tail() == before {
			time.Sleep(time.Millisecond)
		}
	}
	wg.Wait()
	want := []string{"start 1", "end 1", "start 2", "end 2", "start 3", "end 3"}
	if !slices.Equal(order, want) {
		t.Fatalf("order %v, want %v", order, want)
	}
}

func TestSerializeKeepsGoingAfterAFailure(t *testing.T) {
	calls := 0
	tr := Serialize(func([]float32) (string, error) {
		calls++
		switch calls {
		case 1:
			return "", errors.New("first fails")
		case 2:
			panic("second panics")
		}
		return "third", nil
	})
	if _, err := tr.Transcribe(make([]float32, 1)); err == nil {
		t.Fatal("first decode did not fail")
	}
	if _, err := tr.Transcribe(make([]float32, 1)); err == nil {
		t.Fatal("panicking decode did not fail")
	}
	text, err := tr.Transcribe(make([]float32, 1))
	if err != nil || text != "third" {
		t.Fatalf("third decode = %q, %v", text, err)
	}
}

func TestCheckModelFiles(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{EncoderFile, TokensFile} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	err := CheckModelFiles(dir)
	want := fmt.Sprintf("model files missing in %s: decoder.int8.onnx, joiner.int8.onnx, run scripts/setup.sh --dictation", dir)
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
	for _, name := range []string{DecoderFile, JoinerFile} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := CheckModelFiles(dir); err != nil {
		t.Fatalf("complete model: %v", err)
	}
	if err := CheckModelFiles("/nonexistent"); err == nil || !strings.Contains(err.Error(), "encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt") {
		t.Fatalf("missing dir: %v", err)
	}
}
