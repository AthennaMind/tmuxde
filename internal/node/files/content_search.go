package files

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"tmuxde/internal/protocol"
)

const contentFileLimit = 1 << 20
const contentScanLimit = 32 << 20
const contentResultLimit = 200
const contentOutputLimit = 256 << 10

type ContentSearchOptions struct {
	Query         string
	Include       string
	Exclude       string
	CaseSensitive bool
}

func (o ContentSearchOptions) Validate() error {
	if strings.TrimSpace(o.Query) == "" || len(utf16.Encode([]rune(o.Query))) > 256 || strings.ContainsAny(o.Query, "\x00\r\n") {
		return errors.New("enter one line of text, up to 256 characters")
	}
	for _, value := range []string{o.Include, o.Exclude} {
		if len(utf16.Encode([]rune(value))) > 512 || strings.Count(value, ",") >= 16 || strings.ContainsAny(value, "\x00\r\n") {
			return errors.New("use up to 16 file patterns and 512 characters per filter")
		}
	}
	return nil
}

// Patterns support *, ** and ?. Patterns without slashes match basenames.
func contentPatterns(value string) []*regexp.Regexp {
	var patterns []*regexp.Regexp
	for _, pattern := range strings.Split(value, ",") {
		pattern = strings.TrimSpace(pattern)
		if pattern == "" {
			continue
		}
		var source strings.Builder
		source.WriteString("^")
		if !strings.Contains(pattern, "/") {
			source.WriteString("(?:.*/)?")
		}
		for len(pattern) > 0 {
			switch {
			case strings.HasPrefix(pattern, "**/"):
				source.WriteString("(?:.*/)?")
				pattern = pattern[3:]
			case strings.HasPrefix(pattern, "**"):
				source.WriteString(".*")
				pattern = pattern[2:]
			case pattern[0] == '*':
				source.WriteString("[^/]*")
				pattern = pattern[1:]
			case pattern[0] == '?':
				source.WriteString("[^/]")
				pattern = pattern[1:]
			default:
				r, size := utf8.DecodeRuneInString(pattern)
				source.WriteString(regexp.QuoteMeta(string(r)))
				pattern = pattern[size:]
			}
		}
		source.WriteString("$")
		patterns = append(patterns, regexp.MustCompile(source.String()))
	}
	return patterns
}

func contentMatches(patterns []*regexp.Regexp, path string) bool {
	return slices.ContainsFunc(patterns, func(pattern *regexp.Regexp) bool { return pattern.MatchString(path) })
}

// SearchContent reads only guarded regular files under root. Limits cover
// scanned bytes, file count, elapsed time and encoded response size.
func SearchContent(ctx context.Context, guard SearchGuard, path string, paths []string, options ContentSearchOptions) (*protocol.RepoContentSearch, error) {
	if err := options.Validate(); err != nil {
		return nil, err
	}
	real, err := guard.Resolve(path)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(real)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	result := &protocol.RepoContentSearch{Kind: "content-search", Root: real, Matches: []protocol.RepoContentMatch{}}
	include, exclude := contentPatterns(options.Include), contentPatterns(options.Exclude)
	expression := regexp.QuoteMeta(options.Query)
	if !options.CaseSensitive {
		expression = "(?i)" + expression
	}
	query := regexp.MustCompile(expression)
	paths = slices.Clone(paths)
	slices.Sort(paths)
	paths = slices.Compact(paths)
	deadline := time.Now().Add(searchTimeout)
	scanned, output := 0, 0
	for index, relative := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if index >= searchEntryLimit || scanned >= contentScanLimit || time.Now().After(deadline) || len(result.Matches) >= contentResultLimit {
			result.Truncated = true
			break
		}
		if !utf8.ValidString(relative) || len(relative) > 4096 || !filepath.IsLocal(relative) || filepath.ToSlash(filepath.Clean(relative)) != relative {
			result.Truncated = true
			continue
		}
		if (len(include) > 0 && !contentMatches(include, relative)) || contentMatches(exclude, relative) {
			continue
		}
		full := filepath.Join(real, relative)
		resolved, err := guard.Resolve(full)
		if err != nil || resolved != full {
			continue
		}
		data, skipped, err := readSearchFile(root, relative, min(contentFileLimit, contentScanLimit-scanned))
		scanned += len(data)
		if err != nil || skipped {
			result.Truncated = true
			continue
		}
		if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
			continue
		}
		lineNumber := 0
		for line := range strings.SplitSeq(string(data), "\n") {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if time.Now().After(deadline) {
				result.Truncated = true
				return result, nil
			}
			lineNumber++
			line = strings.TrimSuffix(line, "\r")
			span := query.FindStringIndex(line)
			if span == nil {
				continue
			}
			match := contentMatch(relative, lineNumber, line, span)
			encoded, _ := json.Marshal(match)
			if len(result.Matches) >= contentResultLimit || output+len(encoded) > contentOutputLimit {
				result.Truncated = true
				return result, nil
			}
			output += len(encoded)
			result.Matches = append(result.Matches, match)
		}
	}
	return result, nil
}

func readSearchFile(root *os.Root, path string, limit int) ([]byte, bool, error) {
	// Nonblocking open prevents special files from hanging a search.
	f, err := root.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	if !info.Mode().IsRegular() || info.Size() > int64(limit) {
		return nil, true, nil
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	return data, len(data) > limit, err
}

func contentMatch(path string, lineNumber int, line string, span []int) protocol.RepoContentMatch {
	before := []rune(line[:span[0]])
	hit := []rune(line[span[0]:span[1]])
	after := []rune(line[span[1]:])
	// Keep matching text visible even when a line has a long prefix.
	prefix := string(before[max(0, len(before)-60):])
	suffix := string(after[:min(len(after), 60)])
	start := len(utf16.Encode([]rune(prefix)))
	width := len(utf16.Encode(hit))
	column := len(utf16.Encode(before)) + 1
	return protocol.RepoContentMatch{Path: path, Line: lineNumber, Column: column, EndColumn: column + width, Preview: prefix + string(hit) + suffix, MatchStart: start, MatchEnd: start + width}
}
