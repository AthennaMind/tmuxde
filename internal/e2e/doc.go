// Package e2e runs the hub edge, with the WebSocket server and GET /file,
// in front of the real local node, against a real tmux server, through a
// real WebSocket and HTTP client.
//
// Every test starts its own tmux server on a socket in a temp dir and kills
// it at cleanup. Nothing here talks to the default tmux server. File and
// repository tests work only inside the temp dir that is HOME and the one
// allowed path. Git runs only in temp repositories, with a fixed identity
// and no user or system configuration. The package has no code of its own,
// only tests, enabled by the integration build tag.
//
// Run with go test -tags=integration -run '^TestIntegration' -count=1 ./internal/e2e.
package e2e
