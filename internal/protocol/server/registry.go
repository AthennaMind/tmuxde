package server

import "tmuxde/internal/protocol"

// registry holds every server wire type. Each group file owns one map.
var registry = protocol.Merge(authTypes, sessionTypes, paneTypes, fileTypes, repoWatchTypes, dictationTypes)

// Types lists every registered server wire type, sorted.
func Types() []string {
	return registry.Types()
}

// New returns an empty message of the given wire type.
func New(wireType string) (Message, bool) {
	return registry.New(wireType)
}
