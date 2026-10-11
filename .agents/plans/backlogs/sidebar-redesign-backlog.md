# Sidebar redesign backlog

Plan: `.agents/plans/sidebar-redesign.md`.

## Progress summary

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Rail, resizable panel, persisted prefs, rail status, machine, settings | [x] |
| 2 | Session tree with working rows, actions, keyboard | [x] |
| 3 | Files tree, Changes view, file and diff tabs in main area | [x] |
| 4 | Photos view, toolbar cleanup | [x] |
| 5 | Drag to reorder windows and move panes (protocol work) | [ ] |
| QA | Manual test by user, then playwright pass | [~] |

## How to resume

1. Read the plan, then the session notes below.
2. Desktop entry point: `apps/web/src/components/sidebar/workspace-sidebar.tsx`, mounted by `components/terminal/terminal-workspace.tsx`.
3. Mobile is untouched. It still uses `SessionList`, `SessionCard`, `RepositoryBrowser` and `PaneListPanel`.
4. Checks: `docker compose run --rm tools pnpm typecheck`. Browser checks with playwright-cli in an isolated tmux session, after the user finishes manual testing.

## Phase checklist

### Phase 1: shell

- [x] `ui-store`: `sidebarView`, `sidebarWidth`, `showSidebarView`, `toggleSidebarView`, `setSidebarWidth`. Removed `filesPanelOpen`.
- [x] Prefs persisted under `mtmux-sidebar` (view, width, collapsed).
- [x] Rail: Sessions, Files, Changes with badge, Photos. Bottom: connection dot, machine, settings.
- [x] Resize handle: drag, arrows, Home, End, double click reset. 220 to 480px.
- [x] `MachineSwitcher` compact trigger.
- [x] Deleted `session/sidebar-status.tsx`.
- [x] Ctrl+B and Ctrl+E ignored while focus is in the terminal. Ctrl+E toggles Files view.

### Phase 2: sessions tree

- [x] `stores/session-tree-store.ts`: per session windows and panes, attached session.
- [x] `lib/session-target.ts`: `runInSession` attaches first, sends after `session:attached`.
- [x] `use-websocket.ts`: feeds `session:windows`, `session:attached`, drops state on disconnect and session exit.
- [x] Rows: click select, double click rename or zoom, hover actions, menu, F2, Delete, arrows.
- [x] Actions: new window, rename, kill (confirmed), split right and down, layout presets, zoom, copy contents, browse files here.
- [x] Lock re-prompt for sessions marked require unlock.
- [x] Refresh on layout change (debounced) and on activity (3s throttle).
- [x] Desktop pane count button in window strip opens Sessions view. Desktop `PaneListPanel` no longer mounted.

### Phase 3: files and changes

- [x] `components/files/repository-preview.tsx` extracted from `repository-browser.tsx` (query hook, notice, preview).
- [x] `sidebar/use-repository-state.ts`: context and status for active pane, 15s poll while visible.
- [x] Files view: inline tree from git root, opens down to pane folder, filter, git letters, copy path, insert path.
- [x] Changes view: `ChangesList` dense mode.
- [x] `stores/main-tabs-store.ts`, `terminal/main-tabs.tsx`, `files/file-tab-view.tsx`. Terminal stays mounted and redraws on return.
- [x] Removed 48rem desktop files aside.

### Phase 4: photos and toolbar

- [x] `RecentPhotoList` split out of `RecentPhotos`. Mobile dialog uses it.
- [x] Photos view in sidebar.
- [x] Toolbar: removed Files, Recent photos and Settings buttons.

### Phase 5: optional, needs protocol

- [ ] `window:move` or `swap-window`, `pane:join`. Schemas, both handlers, tests, `docs/reference/upstream/relay/protocol.mdx`.
- [ ] Drag and drop in session tree.

### QA

- [~] Manual test by user.
- [ ] Playwright pass: rail toggles, collapse, resize, cross-session window click, pane zoom, rename, kill confirm, files tree, diff tab, photo reuse.
- [ ] Mobile regression check: sessions tab, files tab, pane sheet, recent photos dialog.
- [ ] Unit tests for `main-tabs-store`, `session-target`, `tmux-labels`.

## Known gaps

- Manual file tree refresh briefly shows "Loading" rows, since `useRepositoryQuery` drops the old result on refresh.
- Copy contents after a network round trip can be refused by Safari clipboard rules. Error toast shows the reason.
- Pane button `aria-label` in window strip still says "pane list" on desktop.

## Session notes

### 2026-10-11

- Analysis and proposal written. User picked rail plus panel, file preview as main-area tab, keep window strip, shortcuts outside terminal only.
- Implemented phases 1 to 4. Typecheck passes. No unit or browser tests run, per user request.
- Cascadia Code across desktop sidebar, its menus, main tab strip and file tab header via new `font-chrome` utility in `apps/web/src/app/globals.css` (ligatures off, zero tracking). Rows and tabs at 13px. Compiled CSS checked, no browser test.
- Removed desktop terminal bar (`terminal-toolbar.tsx` deleted): window strip, new window, pane count, photo upload, search, font size, alerts. Font size moved to rail (`RailFontSize`), search to command palette ("Search terminal"), photo upload to Photos view, alerts to `FloatingAlerts` top center of main area. Mobile window strip unchanged. Typecheck passes.
- Rail font size controls removed. Ctrl/Cmd with `=`/`+`, `-`, `0` are app keys again and work inside the terminal (xterm skips them, `lib/font-zoom-key.js`, renamed from `browser-zoom-key.js`). Context aware (`lib/font-zoom.ts`): file or diff tab, editor overlay or phone Files tab scale code via new `codeZoom` in terminal store and root `--code-zoom`; otherwise terminal font size. Browser page zoom no longer on these keys. Typecheck passes. Renamed unit test updated, not run.
- Committed and pushed to main on user request. Manual test by user done for layout; playwright pass still open.
