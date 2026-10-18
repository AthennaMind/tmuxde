## TmuxDE Install Guide

Runs as your own user with systemd, so it manages the tmux sessions you already have. Linux amd64 or arm64 with tmux and Git installed. The binary speaks plain HTTP; put Caddy or nginx in front for TLS.

## Download

```bash
VERSION=0.0.1
ARCH=amd64   # or arm64
BASE=https://github.com/AthennaMind/tmuxde/releases/download/v${VERSION}
curl -fsSLO ${BASE}/tmuxde_${VERSION}_linux_${ARCH}.tar.gz
curl -fsSLO ${BASE}/checksums.txt
sha256sum --check --ignore-missing checksums.txt
tar -xzf tmuxde_${VERSION}_linux_${ARCH}.tar.gz tmuxde
install -D -m 755 tmuxde ~/.local/bin/tmuxde
```

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
