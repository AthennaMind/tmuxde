## TmuxDE Install Guide

Same `tmuxde` binary runs as server or agent. Install tmux and Git on each machine that manages local sessions. Binary speaks plain HTTP in server mode; put Caddy or nginx in front for TLS.

| System | Archive OS | Architectures | Setup |
| --- | --- | --- | --- |
| Linux | `linux` | `amd64`, `arm64` | systemd instructions below |
| macOS | `darwin` | `amd64`, `arm64` | [Agent with launchd](MACOS.md) |
| FreeBSD | `freebsd` | `amd64`, `arm64` | [BSD](#bsd) |
| OpenBSD | `openbsd` | `amd64`, `arm64` | [BSD](#bsd) |
| NetBSD | `netbsd` | `amd64`, `arm64` | [BSD](#bsd) |
| DragonFly BSD | `dragonfly` | `amd64` | [BSD](#bsd) |

macOS and BSD archives start with releases containing these targets. Choose a release with matching asset. CI checks compilation for every target. Native macOS and BSD runtime checks are not yet part of CI. Bundled `tmuxde-stt` and container images remain Linux amd64/arm64 only.

Linux steps below run as your own user with systemd, so TmuxDE manages tmux sessions you already have.

## Download

```bash
VERSION=REPLACE_WITH_RELEASE_VERSION
ARCH=amd64   # or arm64
BASE=https://github.com/AthennaMind/tmuxde/releases/download/v${VERSION}
curl -fsSLO ${BASE}/tmuxde_${VERSION}_linux_${ARCH}.tar.gz
curl -fsSLO ${BASE}/checksums.txt
sha256sum --check --ignore-missing checksums.txt
tar -xzf tmuxde_${VERSION}_linux_${ARCH}.tar.gz tmuxde
install -D -m 755 tmuxde ~/.local/bin/tmuxde
```

Choose `VERSION` from [releases](https://github.com/AthennaMind/tmuxde/releases), without leading `v`.

- verify the release signature, optional, needs cosign 3

```bash
curl -fsSLO ${BASE}/checksums.txt.sigstore.json
cosign verify-blob checksums.txt --bundle checksums.txt.sigstore.json \
  --certificate-identity https://github.com/AthennaMind/tmuxde/.github/workflows/release.yml@refs/tags/v${VERSION} \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Configure

```bash
mkdir -p ~/.config/tmuxde && chmod 700 ~/.config/tmuxde
cat > ~/.config/tmuxde/tmuxde.env <<EOT
AUTH_TOKEN=$(openssl rand -hex 32)
ALLOWED_PATHS=$HOME
CORS_ORIGINS=https://tmux.example.com
TMUXDE_LISTEN=127.0.0.1:24200
EOT
chmod 600 ~/.config/tmuxde/tmuxde.env
```

`AUTH_TOKEN` is what the browser signs in with. `ALLOWED_PATHS` limits file access, comma separated. `CORS_ORIGINS` is the public origin you will open. Run `tmuxde serve --help` for every setting.

## Service

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/tmuxde.service <<'EOT'
[Unit]
Description=TmuxDE server
After=default.target

[Service]
Type=exec
ExecStart=%h/.local/bin/tmuxde serve
EnvironmentFile=%h/.config/tmuxde/tmuxde.env
Restart=on-failure
RestartSec=2
TimeoutStopSec=15

[Install]
WantedBy=default.target
EOT
systemctl --user daemon-reload
systemctl --user enable --now tmuxde.service
loginctl enable-linger "$USER"
curl -fsS http://127.0.0.1:24200/health
```

- watch logs

```bash
journalctl --user -u tmuxde -f
```

## Reverse proxy

Caddy example. Open `https://tmux.example.com` and sign in with `AUTH_TOKEN`.

```
tmux.example.com {
    reverse_proxy 127.0.0.1:24200
}
```

## Speech, optional

`tmuxde-stt` is large because it embeds the speech models. They extract to the user cache on first start.

```bash
curl -fsSLO ${BASE}/tmuxde-stt_${VERSION}_linux_${ARCH}.tar.gz
sha256sum --check --ignore-missing checksums.txt
tar -xzf tmuxde-stt_${VERSION}_linux_${ARCH}.tar.gz tmuxde-stt
install -D -m 755 tmuxde-stt ~/.local/bin/tmuxde-stt
cat > ~/.config/systemd/user/tmuxde-stt.service <<'EOT'
[Unit]
Description=TmuxDE speech service

[Service]
Type=exec
ExecStartPre=/bin/mkdir -p %h/.local/state/tmuxde/run/stt
ExecStart=%h/.local/bin/tmuxde-stt serve
Environment=STT_SOCKET=%h/.local/state/tmuxde/run/stt/stt.sock
Environment=STT_THREADS=4
Restart=on-failure
RestartSec=2
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOT
echo "STT_SOCKET=$HOME/.local/state/tmuxde/run/stt/stt.sock" >> ~/.config/tmuxde/tmuxde.env
systemctl --user daemon-reload
systemctl --user enable --now tmuxde-stt.service
systemctl --user restart tmuxde.service
~/.local/bin/tmuxde-stt health
```

## Remote machines, optional

On the server, create a credential. The token prints once.

```bash
tmuxde machine add laptop
```

On the remote machine, install the same binary and run the agent as its own user service. Run `tmuxde agent --help` for every setting.

```bash
cat > ~/.config/tmuxde/agent.env <<EOT
TMUXDE_SERVER_URL=https://tmux.example.com
TMUXDE_AGENT_TOKEN=paste-token-here
ALLOWED_PATHS=$HOME
EOT
chmod 600 ~/.config/tmuxde/agent.env
sed 's/tmuxde serve/tmuxde agent/; s/tmuxde.env/agent.env/; s/TmuxDE server/TmuxDE agent/' \
  ~/.config/systemd/user/tmuxde.service > ~/.config/systemd/user/tmuxde-agent.service
systemctl --user daemon-reload
systemctl --user enable --now tmuxde-agent.service
```

## Update

Sessions keep running across restarts.

```bash
install -m 755 tmuxde ~/.local/bin/tmuxde
systemctl --user restart tmuxde.service
```

## BSD

Use native archive for your OS and CPU. Linux archives and Docker images do not provide native BSD binaries. Install tmux and Git with your OS package manager. Use an OS release supported by [current Go toolchain](https://go.dev/wiki/MinimumRequirements).

Download `tmuxde_VERSION_OS_ARCH.tar.gz` and `checksums.txt` from [releases](https://github.com/AthennaMind/tmuxde/releases). Use your OS checksum tool to compare archive SHA-256 against its exact entry in `checksums.txt` before extracting.

For example, after verifying FreeBSD amd64 archive:

```sh
VERSION=REPLACE_WITH_RELEASE_VERSION
tar -xzf "tmuxde_${VERSION}_freebsd_amd64.tar.gz" tmuxde
mkdir -p "$HOME/.local/bin" "$HOME/.config/tmuxde"
chmod 700 "$HOME/.config/tmuxde"
install -m 755 tmuxde "$HOME/.local/bin/tmuxde"
"$HOME/.local/bin/tmuxde" version
```

For server, save private settings and load them into process environment. Run as your user:

```sh
umask 077
cat > "$HOME/.config/tmuxde/tmuxde.env" <<EOF
AUTH_TOKEN=$(openssl rand -hex 32)
ALLOWED_PATHS="\$HOME"
CORS_ORIGINS=http://localhost:24200
TMUXDE_LISTEN=127.0.0.1:24200
TMUXDE_TMUX_LAUNCHER=none
EOF
chmod 600 "$HOME/.config/tmuxde/tmuxde.env"
sh -c '
set -a
. "$HOME/.config/tmuxde/tmuxde.env"
set +a
exec "$HOME/.local/bin/tmuxde" serve
'
```

Open `http://localhost:24200` and sign in with `AUTH_TOKEN` from private settings file. Reuse that file on later starts. Put HTTPS proxy in front for access from other machines and update `CORS_ORIGINS`. For agent, follow [remote machine credentials and settings](../internal/machine/README.md#agent), with `TMUXDE_TMUX_LAUNCHER=none`. Ensure tmux and Git are in PATH, including `/usr/local/bin` or `/usr/pkg/bin` where used.

Use OS service manager for persistence under your user account. Linux systemd and macOS launchd examples do not apply to BSD. Native BSD service recipes and runtime tests are not included yet.
