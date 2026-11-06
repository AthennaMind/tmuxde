package protocol

import "errors"

// RepoContentSearch contains one match per line in current disk content.
type RepoContentSearch struct {
	Kind      string             `json:"kind"`
	Root      string             `json:"root"`
	Matches   []RepoContentMatch `json:"matches"`
	Truncated bool               `json:"truncated"`
}

func (*RepoContentSearch) RepoKind() string { return "content-search" }
func (r *RepoContentSearch) Validate() error {
	return errors.Join(kindLiteral(r, r.Kind), RequiredSlice("matches", r.Matches), MaxItems("matches", r.Matches, 200), Each("matches", r.Matches))
}

// Columns are one-based UTF-16 positions. Preview offsets are zero-based.
type RepoContentMatch struct {
	Path       string `json:"path"`
	Line       int    `json:"line"`
	Column     int    `json:"column"`
	EndColumn  int    `json:"endColumn"`
	Preview    string `json:"preview"`
	MatchStart int    `json:"matchStart"`
	MatchEnd   int    `json:"matchEnd"`
}

func (m RepoContentMatch) Validate() error {
	return errors.Join(LengthBetween("path", m.Path, 1, 4096), Between("line", m.Line, 1, 1_048_577), Between("column", m.Column, 1, 1_048_577), Between("endColumn", m.EndColumn, 1, 1_048_577), LengthBetween("preview", m.Preview, 0, 600), Between("matchStart", m.MatchStart, 0, 600), Between("matchEnd", m.MatchEnd, 0, 600))
}
