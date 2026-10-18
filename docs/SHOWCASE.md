## TmuxDE Showcase

## Features

| Feature | What it does | Demo |
| --- | --- | --- |
| Overview | One gallery with a live screen of every pane on every machine. Click a card to jump to that pane. | [Overview](#overview) |
| Just tmux | One click or Ctrl+B collapses the sidebar. Your tmux fills the browser. | [Overview](#overview) |
| Workspace follows the pane | `cd` in any pane and the file tree, branch and change count move to that repository. Nothing to open, nothing to configure. | [Workspace follows the pane](#workspace-follows-the-pane) |
| Peek | Hover a pane in the sidebar for a live preview. Press P to open it from the keyboard. | [Peek](#peek) |
| Git | Staged, unstaged and untracked files, diffs, commits, history and a branch graph for the repository under the focused pane. | [Git](#git) |
| Command palette | Ctrl/Cmd+K for views, sessions, windows, panes, tmux actions, themes, snippets and recent commands. | [Command palette](#command-palette) |
| Find files and search terminals | Ctrl/Cmd+P finds a file and opens it. Ctrl/Cmd+Shift+F searches retained terminal history on every machine. | [Command palette](#command-palette) |
| Terminal themes | Dracula, Solarized Dark, One Dark, Tokyo Night, Catppuccin Mocha, Nord, Gruvbox Dark, Monokai or the app theme. Your tmux theme stays untouched. | [Command palette](#command-palette) |
| Remote machines | TmuxDE agents bring remote tmux, files and Git into the same sidebar. Each machine keeps its own scope. | [Remote machines](#remote-machines) |
| Phone | Same sessions on a phone, with a key toolbar, touch pane grid and repository browser. | [Phone](#phone) |
| Speech to text | Optional dictation into the tmux cursor through a local speech service. | No clip. Needs a microphone. |

No telemetry, update checks, accounts or CDN assets. There is nothing to film for that. Read the source.

## Overview

![Overview][overview]

One window with four panes: btop, htop, tig and a `go test` loop. The sidebar collapses with one click and tmux takes the whole browser. The Overview tab shows every pane on every machine as a live screen, including the two remote agents. A click on a card opens that pane.

## Workspace follows the pane

![Workspace follows the pane][cwd]

A plain shell in a folder with four repositories. After `cd orders-api` the Files panel shows that repository with its branch, and Changes counts the modified files. `cd ../orders-web` switches to the next repository. `cd ../tmux` shows a clone of tmux with its full history. No project was opened at any point.

## Peek

![Peek][peek]

Hover a pane cell or a single pane window in the sidebar. After half a second a live preview opens next to it. Move to the next cell and the preview follows. It works for panes on remote machines too.

## Git

![Git][git]

Changes lists staged, unstaged and untracked files. A click opens the diff as a tab. History lists commits, and a click opens the commit with its patch. Open graph draws the branch graph of the repository under the focused pane.

## Command palette

![Command palette][palette]

Ctrl+K opens the palette. Typing `catppuccin` lists the terminal theme and applies it at once. Ctrl+P finds a file in the current repository and opens it with syntax highlighting. Ctrl+Shift+F searches retained terminal history across all machines and shows the matches with context.

## Remote machines

![Remote machines][remote]

Dev Alpha and Dev Beta are agents in their own containers with their own tmux servers. Their sessions sit in the same sidebar as the local ones. Files, Changes and diffs follow the pane on the remote machine. Switching to the other agent is one click.

## Phone

![Phone][phone]

Sessions, the terminal with its key toolbar, and the repository browser on a 390x844 screen.

[overview]: https://raw.githubusercontent.com/AthennaMind/tmuxde-assets/main/showcase/overview.gif
[cwd]: https://raw.githubusercontent.com/AthennaMind/tmuxde-assets/main/showcase/cwd.gif
[peek]: https://raw.githubusercontent.com/AthennaMind/tmuxde-assets/main/showcase/peek.gif
[git]: https://raw.githubusercontent.com/AthennaMind/tmuxde-assets/main/showcase/git.gif
[palette]: https://raw.githubusercontent.com/AthennaMind/tmuxde-assets/main/showcase/palette.gif
[remote]: https://raw.githubusercontent.com/AthennaMind/tmuxde-assets/main/showcase/remote.gif
[phone]: https://raw.githubusercontent.com/AthennaMind/tmuxde-assets/main/showcase/phone.png
