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
- No cloud speech recognition. Optional dictation downloads its models once, during setup, and only when you turn it on.

## Talk to your terminal

Press the mic and talk. The words land where you type. This is built for driving coding agents from a phone, where typing a long prompt is the slowest part.

- Mic in the phone toolbar and the desktop sidebar, or `Ctrl+Shift+Space`.
- A focused text field gets the words. Otherwise they are pasted into the selected pane without pressing Enter, so you read them before anything runs.
- Text appears after each pause while you keep talking.
- English and Bulgarian, and 23 more European languages. The language is detected per sentence.
- Speech to text runs on your machine. Audio never leaves your network and is never stored.

Dictation is an optional component and off by default. Turn it on with `scripts/setup.sh --dictation`. See the [setup guide](.docker/README.md#dictation-optional) and [speech service](apps/stt/README.md).

## How it works

```
browser (IDE) ──► relay ──► tmux server
                    └─────► speech service (optional)
```

tmuxde has two parts. The relay runs on the machine that hosts tmux and talks to its tmux server. The web client is the IDE you open in a browser, and it reaches the relay over your private network. The optional speech service turns dictation into text. Only the relay can reach it.

## Credits

tmuxde is a fork of [mtmux](https://github.com/mtmux/mtmux) by Gagandeep Singh. It drops the CLI, hosted broker, accounts and billing, and keeps the web client and relay for self-hosting. MIT license, see [LICENSE](LICENSE).
