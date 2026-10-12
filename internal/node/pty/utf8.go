package pty

import (
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

// replacement stands in for bytes that can never form valid UTF-8.
const replacement = "\uFFFD"

// carry turns a byte stream into valid UTF-8 strings.
//
// A pty read can end in the middle of a multibyte sequence. Those trailing
// bytes wait for the next read instead of becoming U+FFFD. Bytes that can
// never start or continue a valid sequence are replaced with U+FFFD, one per
// maximal invalid subpart. Browsers and Node's string decoder do the same,
// so terminal:output stays identical to what the Node relay sent.
type carry struct {
	pending [utf8.UTFMax - 1]byte
	n       int
	scratch []byte
}

// decode returns all complete text in the pending bytes plus p. An
// incomplete sequence at the end is kept for the next call.
func (c *carry) decode(p []byte) string {
	b := p
	if c.n > 0 {
		c.scratch = append(append(c.scratch[:0], c.pending[:c.n]...), p...)
		b = c.scratch
	}
	keep := partialTail(b)
	c.n = copy(c.pending[:], b[len(b)-keep:])
	return sanitize(b[:len(b)-keep])
}

// flush returns what is still pending at end of stream. An incomplete
// sequence can no longer complete, so it becomes one U+FFFD.
func (c *carry) flush() string {
	s := sanitize(c.pending[:c.n])
	c.n = 0
	return s
}

// errStopped ends pump when emit refuses more text.
var errStopped = errors.New("pty: output stopped")

// pump reads r until a read fails and passes decoded text to emit. Empty
// strings are never emitted. before runs ahead of every read. pump returns
// errStopped when emit returns false, else the read error.
func pump(r io.Reader, buf []byte, before func(), emit func(string) bool) error {
	var dec carry
	for {
		if before != nil {
			before()
		}
		n, err := r.Read(buf)
		if n > 0 {
			if s := dec.decode(buf[:n]); s != "" && !emit(s) {
				return errStopped
			}
		}
		if err != nil {
			if s := dec.flush(); s != "" && !emit(s) {
				return errStopped
			}
			return err
		}
	}
}

// partialTail returns how many bytes at the end of b are an incomplete but
// so far valid UTF-8 sequence. It is 0 when b ends on a boundary or when the
// tail is invalid anyway.
func partialTail(b []byte) int {
	for k := 1; k < utf8.UTFMax && k <= len(b); k++ {
		c := b[len(b)-k]
		if c < 0x80 {
			return 0
		}
		if c < 0xC0 {
			// Continuation byte. The lead byte is further back.
			continue
		}
		if seqLen(c) > k && prefixLen(b[len(b)-k:]) == k {
			return k
		}
		return 0
	}
	return 0
}

// sanitize converts b to a string, replacing each maximal invalid subpart
// with one U+FFFD.
func sanitize(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b) + len(replacement))
	for i := 0; i < len(b); {
		r, size := utf8.DecodeRune(b[i:])
		if r != utf8.RuneError || size > 1 {
			sb.Write(b[i : i+size])
			i += size
			continue
		}
		skip := max(prefixLen(b[i:]), 1)
		sb.WriteString(replacement)
		i += skip
	}
	return sb.String()
}

// seqLen returns the length of the sequence that lead byte c starts, or 0
// when c can not start one.
func seqLen(c byte) int {
	switch {
	case c < 0x80:
		return 1
	case c < 0xC2:
		// Continuation byte, or the overlong leads C0 and C1.
		return 0
	case c < 0xE0:
		return 2
	case c < 0xF0:
		return 3
	case c < 0xF5:
		return 4
	}
	return 0
}

// prefixLen returns how many bytes at the start of s form a valid prefix of
// one UTF-8 sequence. It is 0 when s[0] can not start a sequence. Second
// byte ranges follow RFC 3629, so overlongs and surrogates are cut short.
func prefixLen(s []byte) int {
	if len(s) == 0 {
		return 0
	}
	n := seqLen(s[0])
	if n == 0 {
		return 0
	}
	lo, hi := byte(0x80), byte(0xBF)
	switch s[0] {
	case 0xE0:
		lo = 0xA0
	case 0xED:
		hi = 0x9F
	case 0xF0:
		lo = 0x90
	case 0xF4:
		hi = 0x8F
	}
	i := 1
	for ; i < n && i < len(s); i++ {
		if s[i] < lo || s[i] > hi {
			break
		}
		lo, hi = 0x80, 0xBF
	}
	return i
}
