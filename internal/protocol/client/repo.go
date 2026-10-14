package client

import (
	"errors"

	"tmuxde/internal/protocol"
)

var repoWatchTypes = map[string]func() Message{
	"repo:watch":   func() Message { return &RepoWatch{} },
	"repo:unwatch": func() Message { return &RepoUnwatch{} },
}

// RepoWatch asks for repo:changed events from the repository of pane ID.
// The ownership rule of repo:request applies. Path is the captured context
// folder. It must be absolute, and the handler checks it against the
// allowed paths. Without it the watch starts from the pane folder.
type RepoWatch struct {
	Type string  `json:"type"`
	ID   string  `json:"id"`
	Path *string `json:"path,omitempty"`
}

func (*RepoWatch) WireType() string { return "repo:watch" }

func (m *RepoWatch) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "repo:watch"),
		protocol.MinLength("id", m.ID, 1),
	)
}

// RepoUnwatch stops the watch of the repository at Root, as
// repo:watch:result named it.
type RepoUnwatch struct {
	Type string `json:"type"`
	Root string `json:"root"`
}

func (*RepoUnwatch) WireType() string { return "repo:unwatch" }

func (m *RepoUnwatch) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "repo:unwatch"),
		protocol.MinLength("root", m.Root, 1),
	)
}
