package files

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

const searchEntryLimit = 100_000
const searchResultLimit = 100
const searchTimeout = 3 * time.Second

// SearchGuard is shared by file and repository services.
type SearchGuard interface{ Resolve(string) (string, error) }

// SearchResult contains relative file paths within Path. Truncated also covers
// unreadable subdirectories or a scan budget reached before completion.
type SearchResult struct {
	Path      string
	Files     []string
	Truncated bool
}

type searchMatch struct {
	path  string
	score int
}

// Search reads names only. Root confines filesystem reads even if a directory
// is replaced with a symlink during traversal. Policy is checked for each path.
func Search(ctx context.Context, guard SearchGuard, path, query string) (SearchResult, error) {
	return search(ctx, guard, path, query, searchEntryLimit, searchResultLimit)
}

func search(ctx context.Context, guard SearchGuard, path, query string, entryLimit, resultLimit int) (SearchResult, error) {
	result := SearchResult{Files: []string{}}
	real, err := guard.Resolve(path)
	if err != nil {
		return result, err
	}
	result.Path = real
	root, err := os.OpenRoot(real)
	if err != nil {
		return result, err
	}
	defer root.Close()
	terms := strings.Fields(strings.ToLower(query))
	if len(terms) == 0 {
		return result, nil
	}
	deadline := time.Now().Add(searchTimeout)
	scanned := 0
	matches := make([]searchMatch, 0, resultLimit+1)
	compare := func(a, b searchMatch) int {
		if a.score != b.score {
			return a.score - b.score
		}
		if len(a.path) != len(b.path) {
			return len(a.path) - len(b.path)
		}
		return strings.Compare(a.path, b.path)
	}
	var walk func(string, int) error
	walk = func(dir string, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > 64 || scanned >= entryLimit || time.Now().After(deadline) {
			result.Truncated = true
			return nil
		}
		f, err := root.Open(dir)
		if err != nil {
			if dir == "." {
				return err
			}
			result.Truncated = true
			return nil
		}
		defer f.Close()
		for {
			entries, readErr := f.ReadDir(128)
			for _, entry := range entries {
				if err := ctx.Err(); err != nil {
					return err
				}
				if scanned >= entryLimit || time.Now().After(deadline) {
					result.Truncated = true
					return nil
				}
				scanned++
				name := entry.Name()
				if !utf8.ValidString(name) {
					result.Truncated = true
					continue
				}
				rel := filepath.Join(dir, name)
				full := filepath.Join(real, rel)
				if entry.IsDir() {
					switch name {
					case ".git", "node_modules", ".cache", ".venv", "__pycache__":
						continue
					}
					resolved, err := guard.Resolve(full)
					if err != nil || !isWithin(resolved, real) {
						continue
					}
					if err := walk(rel, depth+1); err != nil {
						return err
					}
					continue
				}
				score, matched := searchScore(filepath.ToSlash(rel), terms)
				if !matched {
					continue
				}
				resolved, err := guard.Resolve(full)
				if err != nil || !isWithin(resolved, real) {
					continue
				}
				// Never follow directory symlinks. File symlinks still pass both guards.
				info, err := root.Stat(rel)
				if err != nil || !info.Mode().IsRegular() {
					continue
				}
				if len(rel) > 4096 {
					result.Truncated = true
					continue
				}
				matches = append(matches, searchMatch{path: filepath.ToSlash(rel), score: score})
				slices.SortFunc(matches, compare)
				if len(matches) > resultLimit {
					matches = matches[:resultLimit]
					result.Truncated = true
				}
			}
			if readErr != nil {
				if !errors.Is(readErr, io.EOF) {
					result.Truncated = true
				}
				return nil
			}
		}
	}
	if err := walk(".", 0); err != nil {
		return result, err
	}
	bytes := 0
	for _, match := range matches {
		bytes += len(match.path)
		if bytes > 128*1024 {
			result.Truncated = true
			break
		}
		result.Files = append(result.Files, match.path)
	}
	return result, nil
}

// Prefer exact basenames, then prefixes, substrings, paths and fuzzy matches.
func searchScore(path string, terms []string) (int, bool) {
	path = strings.ToLower(path)
	name := filepath.Base(path)
	score := 0
	for _, term := range terms {
		switch {
		case name == term:
		case strings.HasPrefix(name, term):
			score += 100
		case strings.Contains(name, term):
			score += 200
		case strings.Contains(path, term):
			score += 300
		default:
			needle := []rune(term)
			at, gaps := 0, 0
			for _, ch := range path {
				if ch == needle[at] {
					at++
					if at == len(needle) {
						break
					}
				} else if at > 0 {
					gaps++
				}
			}
			if at != len(needle) {
				return 0, false
			}
			score += 400 + gaps
		}
	}
	return score, true
}
