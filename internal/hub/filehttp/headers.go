package filehttp

import (
	"math"
	"strconv"
	"strings"
)

// octetStream is the type of every extension the table does not know.
const octetStream = "application/octet-stream"

// mimeTypes started as the relay table in apps/relay/src/mime.ts, keyed
// by the lower case extension without the dot. It covers what the file
// preview shows. A blob keeps the type of its response, and an iframe
// saves an octet stream instead of showing a PDF, so the type matters.
var mimeTypes = map[string]string{
	// Images
	"png":  "image/png",
	"jpg":  "image/jpeg",
	"jpeg": "image/jpeg",
	"gif":  "image/gif",
	"svg":  "image/svg+xml",
	"webp": "image/webp",
	"avif": "image/avif",
	"apng": "image/apng",
	"bmp":  "image/bmp",
	"ico":  "image/x-icon",
	// Video
	"mp4":  "video/mp4",
	"m4v":  "video/x-m4v",
	"webm": "video/webm",
	"mov":  "video/quicktime",
	"ogv":  "video/ogg",
	"mkv":  "video/x-matroska",
	// Audio
	"mp3":  "audio/mpeg",
	"wav":  "audio/wav",
	"ogg":  "audio/ogg",
	"oga":  "audio/ogg",
	"opus": "audio/ogg",
	"weba": "audio/webm",
	"flac": "audio/flac",
	"m4a":  "audio/mp4",
	"aac":  "audio/aac",
	// Documents
	"pdf": "application/pdf",
	// Fonts
	"ttf":   "font/ttf",
	"otf":   "font/otf",
	"woff":  "font/woff",
	"woff2": "font/woff2",
}

// mimeType returns the Content-Type for a base name. The extension starts
// at the last dot. A dot that starts the name does not count, as with
// path.extname in Node, so ".png" is an octet stream.
func mimeType(name string) string {
	i := strings.LastIndexByte(name, '.')
	if i <= 0 {
		return octetStream
	}
	if t, ok := mimeTypes[strings.ToLower(name[i+1:])]; ok {
		return t
	}
	return octetStream
}

// contentDisposition is the download header of the relay. The quoted name
// has C0 controls, DEL, double quotes and backslashes replaced by "_", so
// it can neither break the quoted string nor the header. filename* carries
// the full name in UTF-8. Browsers prefer it.
func contentDisposition(name string) string {
	return `attachment; filename="` + quotedName(name) + `"; filename*=UTF-8''` + encodeURIComponent(name)
}

// quotedName replaces the bytes the relay regex /[\u0000-\u001f\u007f"\\]/
// matches. All of them are ASCII, so no UTF-8 sequence is cut.
func quotedName(name string) string {
	b := []byte(name)
	for i, c := range b {
		if c < 0x20 || c == 0x7f || c == '"' || c == '\\' {
			b[i] = '_'
		}
	}
	return string(b)
}

// encodeURIComponent is the JavaScript function of that name. Every byte
// outside A-Z, a-z, 0-9 and -_.!~*'() becomes %XX in upper case hex. A
// name that is not valid UTF-8 keeps its raw bytes, encoded one by one.
func encodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if uriUnreserved(c) {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0f])
	}
	return b.String()
}

func uriUnreserved(c byte) bool {
	switch {
	case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9':
		return true
	}
	return strings.IndexByte("-_.!~*'()", c) >= 0
}

// rangeUnit starts the one range form the relay understood.
const rangeUnit = "bytes="

// parseRange ports the relay regex /bytes=(\d+)-(\d*)/. Like the regex it
// is not anchored and takes the first match, so only the first range of a
// list counts. A suffix range such as "bytes=-500" does not match, and the
// caller serves the whole file. A missing end is math.MaxInt64, so the
// caller clamps it to the last byte. Numbers too big for int64 saturate to
// math.MaxInt64, which keeps the relay outcome: a huge start is past the
// end and a huge end is clamped.
func parseRange(header string) (start, end int64, ok bool) {
	rest := header
	for {
		i := strings.Index(rest, rangeUnit)
		if i < 0 {
			return 0, 0, false
		}
		rest = rest[i+len(rangeUnit):]
		first := leadingDigits(rest)
		if first == "" || !strings.HasPrefix(rest[len(first):], "-") {
			continue
		}
		last := leadingDigits(rest[len(first)+1:])
		end = math.MaxInt64
		if last != "" {
			end = parseDigits(last)
		}
		return parseDigits(first), end, true
	}
}

// leadingDigits returns the ASCII digits at the start of s.
func leadingDigits(s string) string {
	n := 0
	for n < len(s) && '0' <= s[n] && s[n] <= '9' {
		n++
	}
	return s[:n]
}

// parseDigits parses a run of ASCII digits. The only possible error is an
// overflow, which saturates.
func parseDigits(s string) int64 {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return math.MaxInt64
	}
	return n
}
