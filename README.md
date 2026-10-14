<p align="center">
  <img src="ui/public/icon-512.png" width="112" alt="tmuxde icon">
</p>

<h1 align="center">tmuxde</h1>

<p align="center"><strong>A Development Environment with tmux as its backend.</strong></p>

tmuxde (Tmux Development Environment) is a self-hosted DE built on top of tmux. tmux is the backend. It owns your sessions, windows, panes and every process running in them. tmuxde is the IDE around it, in your browser, on a desktop or a phone.

## Features

- Your full tmux workflow, themes and configuration in the browser and mobile.
- Rich file previews.
- Files and git integration at the current focused pane / window / split.
- Clipboard image paste.
- Optional speech to text at your tmux cursor.
- No phone home, ever.
    - No telemetry, analytics or crash reporting.
    - No update checks.
    - No accounts, cloud services or external APIs.
    - No CDN assets. Fonts, syntax highlighting and the editor ship in the bundle.

## Why

> **DISCLAIMER: Personal opinion**

For good or, probably, for worse, coding agents changed the job. Most of the day is reading what a dozen processes produced across many repos and deciding what each does next. The traditional IDE was built for a different job and a different thought process. We also don't think that any of the "modern" and bloated new variants is a practical and usable answer to that problem.

tmux already runs the agents. It keeps them alive when the lid closes, it does not care whose agent sits in a pane, and it has been doing this on remote boxes long before any of this. The machine doing the work is not the one in your hands anymore anyway. What tmux never had is a way to see what all those panes did to the code. tmuxde is that. Switch pane or `cd` and files, repo, branch and diff move with you. There is no workspace to set up and no state to lose.

## Who it is for

tmuxde is for people who were in tmux long before agents showed up and see no reason to leave now. Nerds, hackers, engineers who want the process, the shell and the diff in plain sight and distrust anything that hides them. It is a tool, not a product. The people who built it were going to use it every day either way, and that is the only roadmap it has.

## Is this yet another slop?

Most of the code here is written by agents. What is not, these days...? That does not make it slop by default, and it does not make us any less engineers. Design, architecture, the security model and the process behind every change are ours.

This is also the most fun and the most stressful building software has been in years. A few people with a few agents in tmux panes ship what used to take a corporation, and they do it from a phone on a train if they want to. That is the workflow tmuxde is built for. It is also the workflow it was built with.

## How it works

```
browser (IDE) ──https──► Caddy ──unix socket──► tmuxde ──► tmux server
                                                   └─────► speech service (optional)
```

tmuxde is one Go binary on the machine that hosts tmux. It runs as a systemd user service, talks to the tmux server and serves the web client, the IDE you open in a browser over your private network. Caddy in Docker holds TLS with a local CA and only lets private addresses in. The optional speech service turns dictation into text (useful for controlling AI agents from your phone). Only the binary can reach it.

## Run it

Linux with systemd, Docker, tmux and git. From the repository root:

```sh
scripts/setup.sh
docker build -f .docker/prod/tmuxde.Dockerfile --target binary --output type=local,dest=.docker/bin .
scripts/setup.sh --host-service
systemctl --user start tmuxde.service
docker compose up -d --wait caddy
```

Then trust the local CA and sign in with the token from `.docker/.env.token`. The full guide, development setup and dictation are in [.docker/README.md](.docker/README.md).

## Repository

| Path | What |
| --- | --- |
| `cmd/tmuxde`, `internal`, `web` | Go server. Module `tmuxde`, `go.mod` and `vendor/` at the root |
| `ui` | React web client, Vite and React Router |
| `stt` | Optional speech to text service |
| `packages/protocol` | Message schemas, wire fixtures and [PROTOCOL.md](packages/protocol/PROTOCOL.md) |
| `packages/crypto`, `packages/ui-kit` | Device lock crypto and shared UI components |
| `.docker` | Compose files, images, Caddyfile and the host unit template |
| `scripts/setup.sh` | Setup and host service install |

## Credits

tmuxde is a fork of [mtmux](https://github.com/mtmux/mtmux) by Gagandeep Singh. We kept the web client and the message protocol. The Node relay became a Go server, and the CLI, pairing, hosted broker and accounts are gone.
