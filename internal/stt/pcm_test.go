package stt

import (
	"encoding/binary"
	"errors"
	"slices"
	"testing"
)

func pcm(values ...int16) []byte {
	b := make([]byte, 2*len(values))
	for i, v := range values {
		binary.LittleEndian.PutUint16(b[2*i:], uint16(v))
	}
	return b
}

func TestPCM16ReadsLittleEndianSignedSamples(t *testing.T) {
	got, err := PCM16ToFloat32(pcm(16384, -32768, 0))
	if err != nil {
		t.Fatal(err)
	}
	if want := []float32{0.5, -1, 0}; !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPCM16RefusesHalfASample(t *testing.T) {
	if _, err := PCM16ToFloat32(make([]byte, 3)); !errors.Is(err, ErrHalfSample) {
		t.Fatalf("err = %v, want ErrHalfSample", err)
	}
}

func TestPCM16ReadsASlice(t *testing.T) {
	b := pcm(0, 16384)
	got, err := PCM16ToFloat32(b[2:])
	if err != nil {
		t.Fatal(err)
	}
	if want := []float32{0.5}; !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
