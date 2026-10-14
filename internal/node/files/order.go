package files

import (
	"cmp"
	"strings"
	"unicode"
	"unicode/utf8"

	"tmuxde/internal/protocol"
)

// sortEntries puts directories first, then orders by name with
// compareNames. A symlink to a directory has type symlink and sorts with
// the files, as in the relay.
func sortEntries(a, b protocol.FileEntry) int {
	da, db := a.Type == "directory", b.Type == "directory"
	switch {
	case da && !db:
		return -1
	case db && !da:
		return 1
	}
	return compareNames(a.Name, b.Name)
}

// CompareNames is the name order of file:list. The repository list uses
// it too, so both views sort the same. See compareNames.
func CompareNames(a, b string) int { return compareNames(a, b) }

// compareNames orders names case insensitively. Each rune is folded with
// Unicode simple case folding and the folded code points are compared.
// Names that fold the same are ordered by their bytes, so the order is
// total and stable across runs.
//
// The relay used localeCompare, which is ICU collation. ICU sorts accented
// letters next to their base letter and orders punctuation by its own
// tables. Here U+00E9 (e acute) sorts after "z", and punctuation sorts by
// code point. Plain ASCII names come out the same in most cases. Matching
// ICU exactly needs golang.org/x/text/collate, a dependency this port does
// not take.
func compareNames(a, b string) int {
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		ra, na := utf8.DecodeRuneInString(a[i:])
		rb, nb := utf8.DecodeRuneInString(b[j:])
		if c := cmp.Compare(foldRune(ra), foldRune(rb)); c != 0 {
			return c
		}
		i += na
		j += nb
	}
	switch {
	case i < len(a):
		return 1
	case j < len(b):
		return -1
	}
	return strings.Compare(a, b)
}

// foldRune maps every rune of one simple case folding orbit to the same
// member: the smallest lowercase one when the orbit has one, else the
// smallest. So "K", "k" and the Kelvin sign all become "k".
func foldRune(r rune) rune {
	if r < utf8.RuneSelf {
		if 'A' <= r && r <= 'Z' {
			return r + 'a' - 'A'
		}
		return r
	}
	least, lower := r, rune(-1)
	if unicode.IsLower(r) {
		lower = r
	}
	for f := unicode.SimpleFold(r); f != r; f = unicode.SimpleFold(f) {
		least = min(least, f)
		if unicode.IsLower(f) && (lower < 0 || f < lower) {
			lower = f
		}
	}
	if lower >= 0 {
		return lower
	}
	return least
}
