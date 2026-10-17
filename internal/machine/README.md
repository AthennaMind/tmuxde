# Remote machines

One tmuxde server hosts UI and browser authentication. Agents connect outbound
through HTTPS. Each agent owns its tmux server, files, repositories and path
guards. Central server can run alongside local tmux or without it.

## Central server

Existing `tmuxde serve` keeps local machine enabled. Set `TMUXDE_LOCAL_NODE=false`
for central-only mode. Browser `AUTH_TOKEN`, `CORS_ORIGINS` and listener settings
still apply. Central-only mode requires neither tmux nor `ALLOWED_PATHS`.

Keep central server behind existing Caddy private network policy. Agents must
reach its private HTTPS address and trust its certificate. Agents need no inbound
ports. Across networks, provide private VPN connectivity first.

Create one credential per machine on central server, using its state directory:

```sh
umask 077
tmuxde machine add workstation > agent-token
tmuxde machine list
```

`add` prints machine ID and name to stderr, token to stdout. Transfer token through
trusted channel into agent machine's `~/.config/tmuxde/agent-token`, mode 0600.
Remove temporary transfer copy after installation. Registry lives in
`TMUXDE_CONFIG_DIR/machines.json`, with hashes instead of plaintext tokens.
Never use browser AUTH_TOKEN as agent token.

## Agent

Use same tmuxde binary build on central server and agents. Agent machine needs
tmux and git in PATH. Set up existing binary under `~/.local/bin/tmuxde`, then run:

```sh
TMUXDE_SERVER_URL=https://tmuxde.example \
TMUXDE_AGENT_TOKEN_FILE="$HOME/.config/tmuxde/agent-token" \
ALLOWED_PATHS="$HOME/projects" \
~/.local/bin/tmuxde agent
```

`TMUXDE_AGENT_TOKEN` can supply credential instead of token file. Credentials are
removed from process environment before spawning local tools. Token files must
live inside `TMUXDE_CONFIG_DIR`, which file access guards deny.

For private Caddy CA, copy its public root certificate to agent machine. Either
install it in system trust or set `TMUXDE_CA_FILE=/absolute/path/to/root.crt`.
Certificate verification stays enabled. Server URL must be HTTPS origin without
path, credentials or query. Dev Compose enables `TMUXDE_DEV_ALLOW_HTTP=true`
for direct HTTP connections between containers; no certificates are needed locally.

Agent also supports `TMUX_SOCKET`, `TMUX_DEFAULT_SHELL`, `TMUXDE_CONFIG_DIR` and
`TMUXDE_TMUX_LAUNCHER`. It ignores hub settings such as browser token, listener,
origins and dictation socket.

## User service

Create `~/.config/systemd/user/tmuxde-agent.service` on agent machine:

```ini
[Unit]
Description=tmuxde remote machine agent
After=default.target

[Service]
Type=exec
ExecStart=%h/.local/bin/tmuxde agent
EnvironmentFile=%h/.config/tmuxde/agent.env
Environment=TMUXDE_TMUX_LAUNCHER=systemd-run
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=15
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
```

Create
`~/.config/tmuxde/agent.env`, mode 0600, with absolute paths:

```ini
TMUXDE_SERVER_URL=https://tmuxde.example
TMUXDE_AGENT_TOKEN_FILE=/home/user/.config/tmuxde/agent-token
ALLOWED_PATHS=/home/user/projects
TMUXDE_CA_FILE=/home/user/.config/tmuxde/root.crt
```

Omit CA setting when system trust already covers server certificate. Add PATH to
service environment if tmux or git live outside default user service PATH.

```sh
systemctl --user daemon-reload
systemctl --user enable --now tmuxde-agent.service
journalctl --user -u tmuxde-agent.service -f
```

Service requires tmux server to start in separate systemd scope. Agent restarts
close attach clients and watches while tmux sessions continue. Existing tmux
servers started outside service also remain independent. User service persistence
across logout depends on host's user manager and linger configuration.

## Browser

Login once at central server. Sessions sidebar lists every registered machine
with online status and live session, window and pane trees. Inventory connections
never attach terminals. Remote deep links use `/m/<machine-id>/s/<session-name>`.
Existing local routes keep working.

Tab strip is global. Each machine/session pair opens one terminal tab. Files,
diffs, commits and graphs keep their original machine, session and pane context.
Switching terminals keeps those tabs in place. Matching paths and commit hashes on
different machines remain separate. Selecting a saved file or repository tab
reconnects to its original context before issuing requests.

Workspace transitions unmount old consumers before replacing active socket and
machine-scoped state. Unsaved editor changes ask before leaving. Machine sessions
continue in tmux. An offline agent keeps its place in sidebar. Mutations are not
replayed after connection loss. Lock and sign-out disconnect every browser socket.

Dictation stays on central server. Machine changes cancel recording so late
transcription cannot target another machine.

## Credentials and recovery

```sh
tmuxde machine rotate MACHINE_ID > replacement-token
tmuxde machine revoke MACHINE_ID
```

Rotation and revocation disconnect existing agent within roughly two seconds plus
an in-flight heartbeat timeout. Rotate preserves machine ID and saved browser
state. Install replacement token and restart agent to reconnect. Revocation blocks
reconnect until credential is rotated. Restarting central server preserves registry;
agents reconnect with bounded backoff. Keep registry with central server backups.

Simultaneous registrations with same credential are rejected. Each machine may
have at most 64 pending or active data streams. Browser and file streams have
independent sockets and bounded frames, so large downloads do not occupy terminal
stream. No hosted broker, public discovery or browser connections to agents exist.

## Development and checks

Development Caddy routes `/_agent`, `/_agent/stream` and `/machines` to server-dev.
Reload Caddy after route edits. Keep existing server-dev network isolation.

`internal/machine/integration_test.go` starts two local nodes with dedicated tmux
sockets and a TLS test hub. Tests cover duplicate session/pane IDs,
remote range reads, path guards, credentials and reconnect with session survival.
Run natively with `go test -tags=integration -run '^TestIntegration' -count=1 ./internal/machine`.
Default `go test ./internal/machine` runs unit tests without tmux.
