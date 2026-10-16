package tmux

import (
	"context"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"tmuxde/internal/protocol"
)

const (
	searchMaxMatches = 100
	searchMaxPanes   = 256
	searchMaxBytes   = 64 << 20
)

type SearchResult struct {
	Matches       []protocol.TerminalSearchMatch
	SearchedPanes int
	SkippedPanes  int
	Partial       bool
}

// SearchHistory captures existing history without changing tmux state.
// Linked panes are searched once. Hidden and excluded sessions are skipped.
// Plain capture joins soft wraps and includes history before the visible screen.
func (c *Client) SearchHistory(ctx context.Context, query string, caseSensitive bool, exclude []string) (SearchResult, error) {
	result := SearchResult{Matches: []protocol.TerminalSearchMatch{}}
	pattern := regexp.QuoteMeta(query)
	if !caseSensitive {
		pattern = "(?i)" + pattern
	}
	match, err := regexp.Compile(pattern)
	if err != nil || query == "" {
		return result, ErrInvalidArgument
	}
	sessions, err := c.ListSessions(ctx)
	if err != nil {
		return result, err
	}
	seen := map[string]bool{}
	// A locked session can share a window with another session. Exclude its
	// panes everywhere so a link cannot reveal the same history under a new name.
	for _, session := range sessions {
		if !slices.Contains(exclude, session.Name) {
			continue
		}
		panes, err := c.ListPanes(ctx, session.Name, "")
		if err != nil {
			return result, err
		}
		for _, pane := range panes {
			seen[pane.ID] = true
		}
	}
	bytesRead := 0
	for _, session := range sessions {
		if ctx.Err() != nil {
			result.Partial = true
			return result, nil
		}
		if IsClone(session.Name) || slices.Contains(exclude, session.Name) {
			continue
		}
		panes, err := c.ListPanes(ctx, session.Name, "")
		if err != nil {
			result.Partial = true
			continue
		}
		for _, pane := range panes {
			if seen[pane.ID] {
				continue
			}
			seen[pane.ID] = true
			if ctx.Err() != nil || result.SearchedPanes+result.SkippedPanes >= searchMaxPanes || bytesRead >= searchMaxBytes || len(result.Matches) >= searchMaxMatches {
				result.Partial = true
				return result, nil
			}
			text, cut, err := c.exec(ctx, c.withSocket([]string{"capture-pane", "-p", "-J", "-t", pane.ID, "-S", "-"}))
			if err != nil {
				result.SkippedPanes++
				result.Partial = true
				continue
			}
			bytesRead += len(text)
			if cut {
				// Output cap can split a UTF-8 character or logical line.
				if end := strings.LastIndexByte(text, '\n'); end >= 0 {
					text = text[:end+1]
				} else {
					text = ""
				}
			}
			result.Partial = result.Partial || cut
			result.SearchedPanes++
			base := protocol.TerminalSearchMatch{SessionName: session.Name, WindowID: pane.WindowID, PaneID: pane.ID}
			if pane.Command != nil {
				base.Command = *pane.Command
			}
			if pane.Path != nil {
				base.Path = *pane.Path
			}
			result.Matches, cut = searchLines(ctx, text, match, base, result.Matches)
			result.Partial = result.Partial || cut
		}
	}
	return result, nil
}

// Walk backwards without allocating an array for every history line.
func searchLines(ctx context.Context, text string, match *regexp.Regexp, base protocol.TerminalSearchMatch, found []protocol.TerminalSearchMatch) ([]protocol.TerminalSearchMatch, bool) {
	text = strings.TrimSuffix(text, "\n")
	lineNumber := strings.Count(text, "\n") + 1
	after := ""
	for end := len(text); end > 0; lineNumber-- {
		if ctx.Err() != nil {
			return found, true
		}
		start := strings.LastIndexByte(text[:end], '\n') + 1
		line := text[start:end]
		if loc := match.FindStringIndex(line); loc != nil {
			if len(found) >= searchMaxMatches {
				return found, true
			}
			item := base
			item.Line = lineNumber
			item.Text = searchExcerpt(line, loc[0], loc[1])
			item.After = clipSearchLine(after, 240)
			if start > 0 {
				previous := strings.LastIndexByte(text[:start-1], '\n') + 1
				item.Before = clipSearchLine(text[previous:start-1], 240)
			}
			found = append(found, item)
		}
		after = line
		end = start - 1
	}
	return found, false
}

func searchExcerpt(line string, start, end int) string {
	left := start
	for i := 0; i < 80 && left > 0; i++ {
		_, size := utf8.DecodeLastRuneInString(line[:left])
		left -= size
	}
	prefix := ""
	if left > 0 {
		prefix = "…"
	}
	return prefix + line[left:end] + clipSearchLine(line[end:], 160)
}

func clipSearchLine(text string, limit int) string {
	count := 0
	for i := range text {
		if count == limit {
			return text[:i] + "…"
		}
		count++
	}
	return text
}
