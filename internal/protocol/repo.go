package protocol

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// Repository payloads, ported from src/ui/src/protocol/repository.ts.
// The repo:request and repo:result messages live in the client and server
// packages. This file holds what they carry.

// RepoActions are the values of repo:request action.
var RepoActions = []string{"context", "list", "read", "status", "diff", "log", "show", "search"}

// RepoScopes mirrors RepoScope.
var RepoScopes = []string{"unstaged", "staged", "untracked"}

// RepoCommitPattern is the format of repo:request commit: a full or
// abbreviated lowercase hash.
var RepoCommitPattern = regexp.MustCompile(`^[0-9a-f]{7,64}$`)

// RepoResult mirrors the RepoResult union. Each kind is its own struct with
// Kind as the first field. Set Kind to the value RepoKind returns. Validate
// refuses any other value.
type RepoResult interface {
	RepoKind() string
	Validate() error
}

// repoKinds maps result.kind to an empty payload.
var repoKinds = map[string]func() RepoResult{
	"context": func() RepoResult { return &RepoContext{} },
	"list":    func() RepoResult { return &RepoList{} },
	"read":    func() RepoResult { return &RepoRead{} },
	"status":  func() RepoResult { return &RepoStatus{} },
	"diff":    func() RepoResult { return &RepoDiff{} },
	"log":     func() RepoResult { return &RepoLog{} },
	"show":    func() RepoResult { return &RepoShow{} },
	"search":  func() RepoResult { return &RepoSearch{} },
	"error":   func() RepoResult { return &RepoError{} },
}

// RepoKinds lists the values of result.kind, in the order of the union.
var RepoKinds = []string{"context", "list", "read", "status", "diff", "log", "show", "search", "error"}

// errNotResultObject is returned for a result that is not a JSON object.
// Within adds the field name.
var errNotResultObject = errors.New("must be an object")

// DecodeRepoResult reads one result object. The kind field picks the
// struct. Keys are checked as Decode checks a message. Validate is not run
// here. The caller validates the whole message.
func DecodeRepoResult(data []byte) (RepoResult, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return nil, errNotResultObject
	}
	raw, ok := fields["kind"]
	if !ok {
		return nil, &FieldError{"kind", "required"}
	}
	var kind string
	if err := json.Unmarshal(raw, &kind); err != nil {
		return nil, &FieldError{"kind", "must be a string"}
	}
	build, ok := repoKinds[kind]
	if !ok {
		return nil, &FieldError{"kind", "must be one of " + strings.Join(RepoKinds, ", ")}
	}
	result := build()
	if err := checkObject(fields, result); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, result); err != nil {
		return nil, err
	}
	return result, nil
}

func kindLiteral(r RepoResult, got string) error {
	return Literal("kind", got, r.RepoKind())
}

// RepoContext answers action context. Root and Branch are null outside a
// Git repository. Branch is null on a detached HEAD.
type RepoContext struct {
	Kind   string  `json:"kind"`
	Path   string  `json:"path"`
	Root   *string `json:"root"`
	Branch *string `json:"branch"`
}

func (*RepoContext) RepoKind() string { return "context" }

func (r *RepoContext) Validate() error {
	return kindLiteral(r, r.Kind)
}

// RepoList answers action list.
type RepoList struct {
	Kind      string      `json:"kind"`
	Path      string      `json:"path"`
	Entries   []FileEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

func (*RepoList) RepoKind() string { return "list" }

func (r *RepoList) Validate() error {
	return errors.Join(
		kindLiteral(r, r.Kind),
		RequiredSlice("entries", r.Entries),
		Each("entries", r.Entries),
	)
}

// RepoRead answers action read.
type RepoRead struct {
	Kind      string `json:"kind"`
	Path      string `json:"path"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
}

func (*RepoRead) RepoKind() string { return "read" }

func (r *RepoRead) Validate() error {
	return kindLiteral(r, r.Kind)
}

// RepoStatus answers action status.
type RepoStatus struct {
	Kind      string            `json:"kind"`
	Root      *string           `json:"root"`
	Branch    *string           `json:"branch"`
	Entries   []RepoStatusEntry `json:"entries"`
	Truncated bool              `json:"truncated"`
}

func (*RepoStatus) RepoKind() string { return "status" }

func (r *RepoStatus) Validate() error {
	return errors.Join(
		kindLiteral(r, r.Kind),
		RequiredSlice("entries", r.Entries),
	)
}

// RepoStatusEntry is one changed path. Path is relative to the repository
// root. Index and Worktree keep the porcelain status characters, spaces
// and "?" included. OriginalPath is set for renames.
type RepoStatusEntry struct {
	Path         string  `json:"path"`
	OriginalPath *string `json:"originalPath,omitempty"`
	Index        string  `json:"index"`
	Worktree     string  `json:"worktree"`
}

// RepoDiff answers action diff. Path is the file as the request named it.
type RepoDiff struct {
	Kind      string `json:"kind"`
	Path      string `json:"path"`
	Scope     string `json:"scope"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
}

func (*RepoDiff) RepoKind() string { return "diff" }

func (r *RepoDiff) Validate() error {
	return errors.Join(
		kindLiteral(r, r.Kind),
		OneOf("scope", r.Scope, RepoScopes...),
	)
}

// RepoLog answers action log with one page of commits. More is true when
// older commits exist past the page.
type RepoLog struct {
	Kind    string       `json:"kind"`
	Root    *string      `json:"root"`
	Branch  *string      `json:"branch"`
	Skip    float64      `json:"skip"`
	Commits []RepoCommit `json:"commits"`
	More    bool         `json:"more"`
}

func (*RepoLog) RepoKind() string { return "log" }

func (r *RepoLog) Validate() error {
	return errors.Join(
		kindLiteral(r, r.Kind),
		RequiredSlice("commits", r.Commits),
		Each("commits", r.Commits),
	)
}

// RepoCommit mirrors RepoCommitSchema. Date is the author date in ISO 8601.
// Refs are decorations as Git prints them, such as "HEAD -> main".
type RepoCommit struct {
	Hash    string   `json:"hash"`
	Parents []string `json:"parents"`
	Author  string   `json:"author"`
	Date    string   `json:"date"`
	Subject string   `json:"subject"`
	Refs    []string `json:"refs"`
}

func (c RepoCommit) Validate() error {
	return errors.Join(
		RequiredSlice("parents", c.Parents),
		RequiredSlice("refs", c.Refs),
	)
}

// RepoShow answers action show. Hidden counts files left out because file
// policy denies their path.
type RepoShow struct {
	Kind      string           `json:"kind"`
	Root      string           `json:"root"`
	Commit    RepoCommitDetail `json:"commit"`
	Files     []RepoCommitFile `json:"files"`
	Hidden    float64          `json:"hidden"`
	Truncated bool             `json:"truncated"`
}

func (*RepoShow) RepoKind() string { return "show" }

func (r *RepoShow) Validate() error {
	return errors.Join(
		kindLiteral(r, r.Kind),
		Nested("commit", r.Commit),
		RequiredSlice("files", r.Files),
	)
}

// RepoCommitDetail is RepoCommitSchema extended with the fields show adds.
type RepoCommitDetail struct {
	RepoCommit
	Email         string `json:"email"`
	Committer     string `json:"committer"`
	CommitterDate string `json:"committerDate"`
	Body          string `json:"body"`
}

// RepoCommitFile mirrors RepoCommitFileSchema. Status is the Git raw status
// letter. Additions and Deletions are null for binary files. Patch is empty
// when output stopped before this file.
type RepoCommitFile struct {
	Path         string   `json:"path"`
	OriginalPath *string  `json:"originalPath,omitempty"`
	Status       string   `json:"status"`
	Additions    *float64 `json:"additions"`
	Deletions    *float64 `json:"deletions"`
	Binary       bool     `json:"binary"`
	Patch        string   `json:"patch"`
}

// RepoError answers any action that failed, permission denials included.
// Message is safe to show.
type RepoError struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

func (*RepoError) RepoKind() string { return "error" }

func (r *RepoError) Validate() error {
	return kindLiteral(r, r.Kind)
}

// RepoSearch answers filename search with workspace-relative file paths.
type RepoSearch struct {
	Kind      string   `json:"kind"`
	Path      string   `json:"path"`
	Files     []string `json:"files"`
	Truncated bool     `json:"truncated"`
}

func (*RepoSearch) RepoKind() string { return "search" }
func (r *RepoSearch) Validate() error {
	err := errors.Join(kindLiteral(r, r.Kind), RequiredSlice("files", r.Files), MaxItems("files", r.Files, 100))
	for _, path := range r.Files {
		err = errors.Join(err, LengthBetween("files", path, 1, 4096))
	}
	return err
}
