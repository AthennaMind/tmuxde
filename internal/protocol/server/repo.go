package server

import (
	"errors"

	"tmuxde/internal/protocol"
)

var repoWatchTypes = map[string]func() Message{
	"repo:watch:result": func() Message { return &RepoWatchResult{} },
	"repo:changed":      func() Message { return &RepoChanged{} },
}

// RepoChangedMaxPaths is the most paths one repo:changed lists.
const RepoChangedMaxPaths = 64

// RepoWatchResult answers repo:watch. Root is null when no repository was
// found. OK false means no events come, and Message says why. Partial means
// only part of the work tree is watched.
type RepoWatchResult struct {
	Type    string  `json:"type"`
	Root    *string `json:"root"`
	OK      bool    `json:"ok"`
	Partial bool    `json:"partial"`
	Message *string `json:"message,omitempty"`
}

func (*RepoWatchResult) WireType() string { return "repo:watch:result" }

func (m *RepoWatchResult) Validate() error {
	return protocol.Literal("type", m.Type, "repo:watch:result")
}

// RepoChanged reports changes in a watched repository. Paths are work tree
// paths relative to Root with forward slashes, sorted, at most
// RepoChangedMaxPaths. Truncated means more changed. Git means HEAD, the
// index or refs changed. Refs means HEAD, packed-refs or a ref changed,
// so history may differ. An index only change sets Git without Refs.
type RepoChanged struct {
	Type      string   `json:"type"`
	Root      string   `json:"root"`
	Git       bool     `json:"git"`
	Refs      bool     `json:"refs"`
	Paths     []string `json:"paths"`
	Truncated bool     `json:"truncated"`
}

func (*RepoChanged) WireType() string { return "repo:changed" }

func (m *RepoChanged) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "repo:changed"),
		protocol.RequiredSlice("paths", m.Paths),
		protocol.MaxItems("paths", m.Paths, RepoChangedMaxPaths),
	)
}
