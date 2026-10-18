---
name: refresh-showcase
description: Re-record the docs/SHOWCASE.md clips on the dev stack after a UI change or a new feature, review them, publish them to AthennaMind/tmuxde-assets and update the document.
---

# Refresh showcase

Use this when the UI changed in a visible way, a new feature needs a clip, or a clip in `docs/SHOWCASE.md` no longer matches the product. The document links to media in the public `AthennaMind/tmuxde-assets` repository. Media never enters this repository.

## Layout

| Path | Role |
| --- | --- |
| `scenes/*.js` | One scripted clip each: overview, cwd, peek, git, palette, remote, phone |
| `scripts/setup.sh` | Builds the demo state in the running dev containers |
| `scripts/record.js` | Records one scene into `.local/showcase/<scene>.gif` and `.mp4` |
| `scripts/sheet.sh` | Contact sheet of a GIF for review |
| `scripts/publish.sh` | Pushes `.local/showcase` to the assets repository |

Output lives in ignored `.local/showcase/`. Temporary frames go to `$TMPDIR/tmuxde-showcase/`.

## Requirements

- Dev stack up: `docker compose up -d --wait`.
- Host `playwright-cli` with its Chromium build. `playwright-cli open` once if the browser is missing. Node on the host runs the scripts; nothing is installed into the repository.
- Docker pulls `mwader/static-ffmpeg:7.1` on first use.

## Steps

1. Demo state. Run `scripts/setup.sh`. It installs htop, btop, tig and vim-tiny into the running `server-dev` and agent containers, creates the repositories under `/home/dev/projects` plus a shallow clone of tmux, writes a prompt and tmux theme for the dev user, and recreates sessions `agents`, `orders-api`, `orders-web`, `infra` and `work`. Other sessions on the dev socket stay untouched. Never touch host tmux.
2. Record. `node scripts/record.js <scene>` for each scene that changed, or all of them. Run them one after another, not in parallel.
3. Review. `scripts/sheet.sh <scene>` prints a PNG path. Read it. Check that btop renders instead of "Terminal size too small", every Overview card has content, the cursor is visible, prompts read `dev` or `alpha`, and the clip ends on the intended view. Fix the scene and record again.
4. Publish. `scripts/publish.sh` clones or pulls the assets repository, copies the media and pushes one commit. Unchanged file names keep the links in `docs/SHOWCASE.md` valid. GitHub's image cache needs about a minute.
5. Document. Update the matching section text in `docs/SHOWCASE.md` so it describes what the clip shows. A new clip needs a table row, a section with `![Name][ref]` and a reference link at the bottom in the same `raw.githubusercontent.com` form. Short sentences, no dashes longer than a hyphen, no emojis. Commit only the document when asked.

## Writing a scene

A scene module exports `prepare(page)` and `run(page)`. Only `run` is recorded. `prepare` selects the session and panel so the clip starts on the right view.

```js
const { sleep, clickAt, glideTo, typeSlow, devTmux, resetWork } = require('../scripts/lib');
module.exports = {
  async prepare(page) {
    await page.locator('[data-tree-row="s:orders-api"]').click();
    await sleep(2000);
  },
  async run(page) {
    await clickAt(page, page.getByRole('button', { name: /^Changes/ }).first());
    await sleep(2500);
  },
};
```

Helpers in `scripts/lib.js`:

- `clickAt(page, target, ms)` and `glideTo(page, target, ms)` move the cursor with real delays, then click. A target is a locator or `{ x, y }`. Use these instead of `locator.click()` or `hover()`, otherwise the cursor jumps and live cells can fail the stability check.
- `typeSlow(page, text)` types into the focused terminal. Click inside the terminal group first.
- `devTmux('$T ...')` runs tmux in `server-dev`. `resetWork()` recreates the `work` session with a clean screen.
- Optional exports: `fps` (default 12), `viewport` (default 1600x900 at 2.4x, rendered to 1920x1080), `png: true` with `compose: [...]` for screenshot scenes like phone.

Selectors that matter:

- Session rows `[data-tree-row="s:<name>"]`, window rows `[data-tree-row^="w:"]`, pane cells inside `getByRole('group', { name: /^Panes of window 0 <window>/ })` as `getByRole('button', { name: /^Pane <n>/ })`.
- Rail buttons by name: `Overview`, `Sessions`, `Files`, `Changes`, `History`, `Settings`, `Hide sidebar`. Machines are `section[aria-label="Dev Alpha"]`.
- Terminal group `getByRole('group', { name: /^Terminal, session <name>/ })`. Palette shortcuts Ctrl+K, Ctrl+P, Ctrl+Shift+F work with terminal focus; Ctrl+B, Ctrl+E and Ctrl+O do not.
- Overview cards `ul[aria-label="Terminal previews"] > li`, commits `ul[aria-label="Commits"] button`, peek popover `[data-radix-popper-content-wrapper]`.

Gotchas learned while recording:

- The screencast only emits frames on repaint. Still periods cost nothing, cursor glides need real delays.
- Overview cards load when visible. Nudge the wheel by 40 pixels down and up after opening the tab.
- Overview cards show the bottom rows of a pane. Shell panes must overflow the screen or their card is blank.
- btop needs 80 columns. The `agents` session widens its column, and the overview scene resizes pane 0 again after the browser attaches.
- A session no browser has attached to keeps tmux's default size. The demo `.tmux.conf` sets `default-size 200x50` so peeks and Overview cards of detached sessions are not squeezed into 80x24.
- The tmux server in `server-dev` starts shells from the tmuxde process environment. `.bashrc` adds Go to `PATH` and `.bash_profile` sources it.
- A persisted session keeps its screen between runs. Reset it in `prepare` when the clip types commands.
