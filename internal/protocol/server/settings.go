package server

import (
	"errors"

	"tmuxde/internal/protocol"
)

var settingsTypes = map[string]func() Message{
	"settings:changed": func() Message { return &SettingsChanged{} },
}

// SettingsChanged says a user document on the hub was saved. The hub
// sends it to every authenticated browser socket after a successful PUT
// /user/{name}. Browsers refetch the document when ETag differs from
// theirs. It is hub owned, so an agent can never send it.
type SettingsChanged struct {
	Type string `json:"type"`
	Name string `json:"name"`
	ETag string `json:"etag"`
}

func (*SettingsChanged) WireType() string { return "settings:changed" }

func (m *SettingsChanged) Validate() error {
	return errors.Join(
		protocol.Literal("type", m.Type, "settings:changed"),
		protocol.OneOf("name", m.Name, "settings", "keybindings"),
		protocol.LengthBetween("etag", m.ETag, 1, 80),
	)
}
