# tmuxde

**An IDE with tmux as its backend.** It follows the pane you select. Nothing leaves your network.

tmuxde (Tmux Development Environment) is a self-hosted IDE built on top of tmux. tmux is the backend. It owns your sessions, windows, panes and every process running in them. tmuxde is the IDE around it, in your browser, on a desktop or a phone.

## The pane is the focus

Everything in the IDE takes its context from the pane you select: its folder, repository and changes follow as you switch panes or `cd`.

## No phone home

tmuxde never talks to anything outside your network.

- No telemetry, analytics or crash reporting.
- No update checks.
- No accounts, cloud services or external APIs.
- No CDN assets. Fonts, syntax highlighting and the editor ship in the bundle.

## How it works

```
browser (IDE) ──► relay ──► tmux server
```

tmuxde has two parts. The relay runs on the machine that hosts tmux and talks to its tmux server. The web client is the IDE you open in a browser, and it reaches the relay over your private network.

## Credits

tmuxde is a fork of [mtmux](https://github.com/mtmux/mtmux) by Gagandeep Singh. It drops the CLI, hosted broker, accounts and billing, and keeps the web client and relay for self-hosting. MIT license, see [LICENSE](LICENSE).
