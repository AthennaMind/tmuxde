## TmuxDE agent on macOS

Connect Mac's tmux sessions, files and Git to an existing TmuxDE server. Requires macOS 13 or newer. Use same release version as server. `tmuxde-stt` remains Linux only.

## Install

Choose `VERSION` from [releases](https://github.com/AthennaMind/tmuxde/releases) with macOS assets. Use `arm64` for Apple Silicon or `amd64` for Intel. Run in an empty download folder:

```sh
brew install tmux git
VERSION=REPLACE_WITH_RELEASE_VERSION
ARCH=arm64
ARCHIVE="tmuxde_${VERSION}_darwin_${ARCH}.tar.gz"
BASE="https://github.com/AthennaMind/tmuxde/releases/download/v${VERSION}"
curl -fSLO "${BASE}/${ARCHIVE}"
curl -fSLO "${BASE}/checksums.txt"
grep " ${ARCHIVE}\$" checksums.txt | shasum -a 256 -c - &&
  tar -xzf "$ARCHIVE" tmuxde &&
  mkdir -p "$HOME/.local/bin" &&
  install -m 755 tmuxde "$HOME/.local/bin/tmuxde"
mkdir -p "$HOME/.config/tmuxde" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/tmuxde"
chmod 700 "$HOME/.config/tmuxde"
```

## Connect to server

On server, run as server user. Use server's `TMUXDE_CONFIG_DIR` if customized:

```sh
umask 077
tmuxde machine add macbook > agent-token
```

Transfer token securely to Mac at `~/.config/tmuxde/agent-token`, then remove transfer copy. On Mac, replace server URL below:

```sh
chmod 600 "$HOME/.config/tmuxde/agent-token"
umask 077
cat > "$HOME/.config/tmuxde/start-agent" <<'EOF'
export TMUXDE_SERVER_URL=https://tmux.example.com
export TMUXDE_AGENT_TOKEN_FILE="$HOME/.config/tmuxde/agent-token"
export ALLOWED_PATHS="$HOME"
# For private CA, copy public root certificate and uncomment:
# export TMUXDE_CA_FILE="$HOME/.config/tmuxde/server-ca.crt"
exec "$HOME/.local/bin/tmuxde" agent
EOF
chmod 600 "$HOME/.config/tmuxde/start-agent"
```

Mac must reach server's HTTPS address. Private servers may need VPN access. Narrow `ALLOWED_PATHS` to project folders if preferred.

## Start at login

Run from Terminal while logged in to macOS desktop. launchd starts agent at login and restarts it after failure. Job stops at logout. Screen lock leaves it running; sleep pauses access.

```sh
cat > "$HOME/Library/LaunchAgents/dev.tmuxde.agent.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>dev.tmuxde.agent</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>${HOME}/.config/tmuxde/start-agent</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>TMUXDE_TMUX_LAUNCHER</key><string>none</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/tmuxde/agent.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/tmuxde/agent.log</string>
</dict></plist>
EOF
plutil -lint "$HOME/Library/LaunchAgents/dev.tmuxde.agent.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.tmuxde.agent.plist"
```

Sign in to TmuxDE server. Mac appears in machines sidebar. `AbandonProcessGroup` disables launchd cleanup of remaining processes in agent's process group, so restarting agent can leave tmux running. See [Apple's plist reference](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5).

## Logs and restart

```sh
tail -n 50 "$HOME/Library/Logs/tmuxde/agent.log"
launchctl print "gui/$(id -u)/dev.tmuxde.agent"
```

After changing settings, reload job. For updates, replace binary between these commands:

```sh
launchctl bootout "gui/$(id -u)/dev.tmuxde.agent"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.tmuxde.agent.plist"
```

To uninstall job, run `bootout` and delete `~/Library/LaunchAgents/dev.tmuxde.agent.plist`.
