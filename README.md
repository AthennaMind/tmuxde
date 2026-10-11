# tmuxde

**A Development Environment with tmux as its backend.**

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
browser (IDE) ──► relay ──► tmux server
                    └─────► speech service (optional)
```

tmuxde has two parts. The relay runs on the machine that hosts tmux and talks to its tmux server. The web client is the IDE you open in a browser, and it reaches the relay over your private network. The optional speech service turns dictation into text (useful for controlling AI agents from your phone). Only the relay can reach it.

## Credits

tmuxde is a fork of [mtmux](https://github.com/mtmux/mtmux) by Gagandeep Singh. We mostly dropped everything except for the protocol and the relay architecture.
