# Desktop sidebar redesign

Status: phases 1 to 4 implemented 2026-10-11, awaiting manual test. Progress in `.agents/plans/backlogs/sidebar-redesign-backlog.md`.

## Problem

Desktop sidebar is a list of session cards with a read-only tree. It shows little, does less, and the useful controls live elsewhere.

### Findings

| Severity | Location | Problem | Fix |
| --- | --- | --- | --- |
| HIGH | `components/session/session-card.tsx:336-357` | Expanded window and pane rows are plain `div`s. No click, no keyboard, no actions. Tree looks interactive and does nothing. | Real tree items: click selects, hover and context menu act. |
| HIGH | `components/session/session-card.tsx:105-141` | Tree fetched once (`hasFetched`), never refreshed. Split, kill or rename a window and the sidebar lies until reload. | Shared tree store refreshed on `window:changed`, `session:activity` and expand. |
| MEDIUM | `components/terminal/terminal-workspace.tsx:332` | Files is a separate `min(48rem,60vw)` aside on the right. Listing and preview share one column, so preview loses your place. Terminal loses most of its width. | Tree in sidebar, preview in narrow right drawer only while a file is open. |
| MEDIUM | `session-card.tsx`, `window-tabs.tsx`, `pane-list-panel.tsx:76` | Panes in three places: sidebar tree (dead), pane sheet (works), strip count. Windows in two (strip works, tree dead). | Sidebar becomes the one structural view. Desktop pane sheet goes. Strip stays as fast switcher. |
| MEDIUM | `session-card.tsx:185-190` | One bordered card per session. One session leaves ~90% of the column empty. Card wrapper `overflow-hidden rounded-lg` clips card border at corners (visible in screenshot). | Flat rows, space grouping, background for selection only. |
| MEDIUM | `session-card.tsx:301,309,314,343,352` | Meta text at 10px and 11px. Unreadable at desk distance. | `text-xs` minimum, `tabular-nums` for counts. |
| MEDIUM | `session-card.tsx:217` | Green dot means "some tmux client is attached", which includes this one. Meaning only in tooltip. | Current session shown by selection. "Open elsewhere" gets its own icon. Activity gets primary dot. |
| LOW | `session-list.tsx:136` | Manual refresh button. Relay already pushes `session:created`, `session:exited`, `session:activity`, `window:changed`. | Drop button. Keep pull to refresh on mobile only. |
| LOW | `terminal-workspace.tsx:278`, `sidebar-status.tsx` | Collapsed sidebar is a 48px strip holding a toggle and a dot. | Collapsed state becomes icon rail with every view reachable. |
| LOW | `terminal-toolbar.tsx` | Toolbar holds windows, photo upload, recent photos, files, search, font size, settings. Crowded, labels drop at 64rem. | Files, recent photos, settings move to rail. |
| RISK | `app/(terminal)/layout.tsx:202-213` | Global Ctrl+B and Ctrl+E fire after xterm already sent the key to tmux. Ctrl+B is tmux default prefix. Ctrl+E is bound to tmux-expose in local `~/.tmux.conf:21`. Not verified in browser. | New shortcuts only fire when focus is outside terminal, or use chords tmux cannot see. See decision 4. |

## Proposed design

### Structure: icon rail plus one panel

```
+------+------------------------------+-------------------------------------------+
| [S]  | Sessions                 [+] | 1 bash | 2 claude * | 3 logs |  +    / Aa |
| [F]  |                              +-------------------------------------------+
| [G]3 | v dev        6 win     now   |                                           |
| [P]  |     1  bash                  |                                           |
|      |   v 2  claude        2 panes |               terminal                    |
|      |     | 0  claude  ~/src/tmuxde |                                           |
|      |       1  bash    ~/src/tmuxde |                                           |
|      |   > 3  logs            *     |                                           |
|      |     + New window             |                                           |
|      | > work       2 win      3h   |                                           |
|      | > scratch    1 win      2d   |                                           |
|      |                              |                                           |
|      |                              |                                           |
| (o)  |                              |                                           |
| [M]  |                              |                                           |
| [*]  |                              |                                           |
+------+------------------------------+-------------------------------------------+
  rail    panel, resizable 240-440px      main
```

Rail, 48px, always visible:

- Top: Sessions, Files, Changes (badge with change count), Photos.
- Bottom: connection dot (latency in tooltip, click reconnects when down), machine (opens existing machine switcher), settings (opens existing settings sheet).
- Click active view icon collapses panel. Click other icon switches view. Collapsed state is rail only, still fully usable.

Panel: one view at a time, full height, resizable by dragging its edge. Width and last view persist per device.

### Sessions view

Tree: session > window > pane. One row type, three depths.

Row anatomy, 28px tall, 12px indent per depth, rounded-md inside 6px panel padding:

```
[chevron 16] [index] name ............ [meta] [state] [hover actions]
```

- Session row: name, window count, last activity. State icons: activity dot (primary), "open in another client" icon, lock icon when session requires unlock.
- Window row: index, name, pane count when more than one, activity dot, zoom icon.
- Pane row: index, command, path shortened from start (`~/src/tmuxde`), zoom icon.

Selection rule: one highlight only. Deepest active item gets `bg-accent`. Its ancestors get `font-medium`. Pending switch (on wire, not confirmed) dims to 70%, same as window strip.

Click behavior:

| Target | Click | Double click |
| --- | --- | --- |
| Session | Attach (honors lock re-prompt) | Rename |
| Window | Attach session if needed, then `window:select` | Rename |
| Pane | Attach and select window if needed, then `pane:select` | Zoom toggle |

Hover actions (also in right-click menu and `...` button, also on keyboard):

- Session: New window, Rename, Kill.
- Window: Split right, Split down, Layout presets, Rename, Kill.
- Pane: Zoom, Split right, Split down, Copy contents (`pane:capture`), Browse folder (opens Files view at pane path), Kill.

Kill always confirms with named dialog. Same copy as today.

Keyboard: `role="tree"` with roving focus. Up/Down move, Right/Left expand and collapse, Enter activates, F2 renames, Delete kills with confirm, Shift+F10 opens menu.

### Files view

```
+------+------------------------------+------------------------------+------------+
| [S]  | tmuxde        main   ~5 +2    | terminal                     | README.md x|
| [F]  | [Filter files            ]   |                              |            |
| [G]5 | v apps                       |                              |  preview   |
| [P]  |   v web                      |                              |  or diff   |
|      |     > src                    |                              |            |
|      |       package.json        M  |                              |            |
|      |   > relay                    |                              |            |
|      | > packages                   |                              |            |
|      |   README.md               *  |                              |            |
|      |                              |                              |            |
|      | Following pane 2.0           |                              |            |
+------+------------------------------+------------------------------+------------+
```

- Real tree with inline folder expansion. Replaces drill-down list.
- Root is git root when present, else pane working directory. Header shows folder name, branch, change counts.
- Follows active pane by default. Footer names the pane it follows.
- Git status letters on rows (M, A, ?, D) from existing `status` query.
- Click file opens a tab in the main area, beside a Terminal tab. Tab strip appears only while a file is open. Terminal stays mounted under it.

### Changes view

Staged, Unstaged, Untracked groups with counts. Click opens diff as a main-area tab. Reuses `repository-changes.tsx` in dense mode.

### Photos view

Recent uploads grid from `recent-photos.tsx`. Upload button stays in toolbar because it is an input action.

### Visual rules

- Group with space and background, not borders. No cards. Panel has one border, on its trailing edge.
- Text: names `text-sm`, meta `text-xs text-muted-foreground tabular-nums`. Nothing under 12px.
- Semantic tokens only: `bg-accent` selected, `bg-primary` activity dot, `text-destructive` kill.
- Icons: lucide, one stroke weight, `currentColor`.
- Motion: chevron rotate and row hover color at 150ms or less. Panel width change instant on drag, 200ms on toggle.
- Hit areas: 28px rows for pointer, 24px minimum for inline icon buttons. Touch density (44px) when same tree is reused on mobile.

## Data flow

No protocol change for phases 1 to 4.

- Relay policy (`apps/relay/src/policy.ts:229`) only allows window and pane ids from the attached session. Cross-session clicks attach first, then select. Client keeps `pendingTarget { session, windowId?, paneId? }` and sends select after `session:attached` and first window list.
- Active session: windows and current window panes from `pane-store` (live). Other windows from `session:windows`, which returns every pane in session (`tmux-manager.ts:345`, `list-panes -s`).
- Other sessions: `session:windows` on expand. Refresh on `session:activity` for that session, throttled.
- One shared tree store and one message subscription. Replaces per-card `onMessage` listeners.
- Split on a specific pane: `pane:select` then `pane:split` (split has no id). Layout presets: current window only, so select first.
- Files tree: `repo:request` `list` per expanded folder, `context` for root and branch, `status` for letters.

## Phases

1. Shell: rail, resizable panel, view state in `ui-store` with persistence, move connection, machine and settings to rail. Toolbar loses Files, recent photos and settings.
2. Sessions tree: tree store, functional rows, cross-session targeting, hover actions, context menu, inline rename, keyboard. Remove desktop `PaneListPanel`. Strip pane count button focuses the tree.
3. Files and Changes: inline tree, file and diff tabs in main area, remove 48rem aside. Shortcut opens Files view.
4. Photos view.
5. Optional, needs protocol work: drag to reorder windows and move panes between windows (`swap-window`, `join-pane`). Requires schemas, both handlers, tests and `docs/reference/upstream/relay/protocol.mdx`.

Mobile untouched in phases 1 to 4. Tree component built density-aware so mobile Sessions tab can adopt it later.

## Decisions (answered 2026-10-11)

1. Layout: rail plus switchable panel.
2. File preview: tab in main area, beside the terminal.
3. Window strip above terminal: kept at first. Removed 2026-10-11 with the whole desktop terminal bar. Windows live in the session tree, font size in the rail, search in the command palette, photo upload in the Photos view, alerts float top center.
4. Shortcuts: fire only when focus is outside the terminal.

## Not verified

- Ctrl+B and Ctrl+E double firing in browser.
- 200% zoom and RTL for current sidebar.
- Settings panel fit at 320px if later moved into the panel instead of the sheet.
