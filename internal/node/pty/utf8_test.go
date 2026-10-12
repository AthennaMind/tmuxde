package pty

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/iotest"
	"unicode/utf8"
)

// mixed has 1, 2, 3 and 4 byte sequences, and a literal U+FFFD that must
// survive as text.
const mixed = "a é € \U0001F600 中文 \uFFFD z ü\U0001F600\U0001F600ß"

// decodeAll feeds parts through one carry and flushes at the end.
func decodeAll(parts ...[]byte) string {
	var c carry
	var sb strings.Builder
	for _, p := range parts {
		sb.WriteString(c.decode(p))
	}
	sb.WriteString(c.flush())
	return sb.String()
}

func TestCarrySplitAtEveryPoint(t *testing.T) {
	b := []byte(mixed)
	for i := 0; i <= len(b); i++ {
		for j := i; j <= len(b); j++ {
			got := decodeAll(b[:i], b[i:j], b[j:])
			if got != mixed {
				t.Fatalf("split at %d,%d: got %q, want %q", i, j, got, mixed)
			}
		}
	}
}

func TestCarryNeverEmitsPartialSequence(t *testing.T) {
	var c carry
	b := []byte("\U0001F600")
	for i := range b[:len(b)-1] {
		if s := c.decode(b[i : i+1]); s != "" {
			t.Fatalf("byte %d: emitted %q before the sequence was complete", i, s)
		}
	}
	if s := c.decode(b[len(b)-1:]); s != "\U0001F600" {
		t.Fatalf("last byte: got %q, want %q", s, "\U0001F600")
	}
	if s := c.flush(); s != "" {
		t.Fatalf("flush after complete text: got %q", s)
	}
}

// twoByteReader hands out at most two bytes per Read, whatever the buffer.
type twoByteReader struct{ r io.Reader }

func (t twoByteReader) Read(p []byte) (int, error) {
	if len(p) > 2 {
		p = p[:2]
	}
	return t.r.Read(p)
}

func TestPumpTwoByteBuffer(t *testing.T) {
	text := strings.Repeat(mixed+"\r\n", 50)
	cases := []struct {
		name string
		r    io.Reader
		buf  int
	}{
		{"two byte buffer", strings.NewReader(text), 2},
		{"two byte reader", twoByteReader{strings.NewReader(text)}, 4096},
		{"one byte reader", iotest.OneByteReader(strings.NewReader(text)), 4096},
		{"three byte buffer", strings.NewReader(text), 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var chunks []string
			err := pump(tc.r, make([]byte, tc.buf), nil, func(s string) bool {
				chunks = append(chunks, s)
				return true
			})
			if !errors.Is(err, io.EOF) {
				t.Fatalf("pump error: %v", err)
			}
			for i, s := range chunks {
				if s == "" {
					t.Fatalf("chunk %d is empty", i)
				}
				if !utf8.ValidString(s) {
					t.Fatalf("chunk %d is not valid UTF-8: %q", i, s)
				}
			}
			if got := strings.Join(chunks, ""); got != text {
				t.Fatalf("joined output differs.\n got %q\nwant %q", got, text)
			}
			if n := strings.Count(strings.Join(chunks, ""), "\uFFFD"); n != 50 {
				t.Fatalf("got %d U+FFFD, want only the 50 literal ones", n)
			}
		})
	}
}

func TestInvalidBytesAreReplaced(t *testing.T) {
	r := "\uFFFD"
	cases := []struct {
		name  string
		parts []string
		want  string
	}{
		{"lone ff", []string{"a\xffb"}, "a" + r + "b"},
		{"lone continuation", []string{"\x80x"}, r + "x"},
		{"truncated 3 byte then ascii", []string{"\xe2\x82A"}, r + "A"},
		{"truncated across reads", []string{"\xe2", "\x82", "A"}, r + "A"},
		{"overlong c0 af", []string{"\xc0\xaf"}, r + r},
		{"surrogate", []string{"\xed\xa0\x80"}, r + r + r},
		{"above max", []string{"\xf4\x90\x80\x80"}, r + r + r + r},
		{"f5 lead", []string{"\xf5\x80"}, r + r},
		{"truncated at end of stream", []string{"ab\xe2\x82"}, "ab" + r},
		{"truncated 4 byte at end", []string{"\xf0\x9f", "\x98"}, r},
		{"valid after invalid", []string{"\xff", "é"}, r + "é"},
		{"literal replacement kept", []string{"x\xef\xbf\xbdy"}, "x" + r + "y"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parts := make([][]byte, len(tc.parts))
			for i, p := range tc.parts {
				parts[i] = []byte(p)
			}
			got := decodeAll(parts...)
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("result is not valid UTF-8: %q", got)
			}
		})
	}
}

// failingReader returns its data, then err.
type failingReader struct {
	data []byte
	err  error
}

func (f *failingReader) Read(p []byte) (int, error) {
	if len(f.data) == 0 {
		return 0, f.err
	}
	n := copy(p, f.data)
	f.data = f.data[n:]
	return n, nil
}

func TestPumpFlushesPendingOnError(t *testing.T) {
	boom := errors.New("boom")
	var got strings.Builder
	err := pump(&failingReader{data: []byte("ok\xe2\x82"), err: boom}, make([]byte, 8), nil,
		func(s string) bool { got.WriteString(s); return true })
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
	if got.String() != "ok\uFFFD" {
		t.Fatalf("got %q, want %q", got.String(), "ok\uFFFD")
	}
}

func TestPumpStopsWhenEmitRefuses(t *testing.T) {
	calls := 0
	err := pump(bytes.NewReader(bytes.Repeat([]byte("x"), 100)), make([]byte, 10), nil,
		func(string) bool { calls++; return calls < 3 })
	if !errors.Is(err, errStopped) {
		t.Fatalf("err = %v, want errStopped", err)
	}
	if calls != 3 {
		t.Fatalf("emit called %d times, want 3", calls)
	}
}

func TestPartialTail(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abc", 0},
		{"é", 0},
		{"a\xc3", 1},
		{"a\xe2\x82", 2},
		{"a\xf0\x9f\x98", 3},
		{"a\xe0\x80", 0}, // overlong prefix, never valid
		{"a\xed\xa0", 0}, // surrogate prefix, never valid
		{"a\x80", 0},     // stray continuation
		{"a\xc1", 0},     // overlong lead
		{"\xe2\x82\xac", 0},
	}
	for _, tc := range cases {
		if got := partialTail([]byte(tc.in)); got != tc.want {
			t.Errorf("partialTail(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}
