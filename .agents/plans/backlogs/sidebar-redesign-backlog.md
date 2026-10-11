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
- [x] Prefs persisted under `tmuxde-sidebar` (view, width, collapsed).
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
- [x] Settings as a main-area tab (`SETTINGS_TAB` in `main-tabs-store`). Rail gear and command palette open it. Right-side Sheet removed.

### Phase 5: optional, needs protocol

- [ ] `window:move` or `swap-window`, `pane:join`. Schemas, both handlers, tests, `docs/reference/upstream/relay/protocol.mdx`.
- [ ] Drag and drop in session tree.

### QA

- [x] Bug: tree split from a pane row landed in the window on screen. `select-pane` never changes the session window. Relay `selectPane` now selects the pane's window through the attached session.
- [x] Bug: tree drew previous window's panes under new active window until `pane:changed` arrived. Live panes now match by window id.
- [x] Bug: Files view missed pane focus by tmux keys and `cd`, and waited up to 5s on window switch. Monitor signature now has pane focus and folder, window poll every 1s. Context refetches on active pane folder change.
- [x] Bug: Files view blanked on every pane switch and reloaded each open folder. Last context and listings stay until next answer lands.
- [x] Splits start in folder of split pane (`split-window -c '#{pane_current_path}'`).
- [x] Bug: Files and Changes stuck on "No session attached" after relay restart or offline tab. Requests went out on "connected", before relay re-attached. Repository state and queries now wait for `session:attached` and retry after reconnect.
- [~] Manual test by user.
- [ ] Playwright pass: rail toggles, collapse, resize, cross-session window click, pane zoom, rename, kill confirm, files tree, diff tab, photo reuse.
- [ ] Mobile regression check: sessions tab, files tab, pane sheet, recent photos dialog.
- [~] Unit tests: `main-tabs-store` done. `session-target`, `tmux-labels` open.

## Known gaps

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

### 2026-10-11 (tree and files fixes)

- User report: splits show in every window switched to, and Files view does not follow pane or window in another folder.
- Relay: `tmux-manager.selectPane(paneId, session)` selects pane's window first (verified on tmux 3.7c that `select-pane -t %id` keeps current window). `session-monitor.ts` adds pane id, focus and folder to signature, window poll 1s, sessions 5s, no overlapping polls.
- Web: `session-tree.tsx` live panes filtered by window id, live folder preferred. `use-repository-state.ts` context key has active pane folder, keeps last context, returns context's own pane id. `files-view.tsx` root keyed by root, manual folders stay open in same repo. `useRepositoryQuery` gained `keepPrevious`.
- Tests: router `pane:select` session, real tmux `selectPane` window, new `session-monitor.test.ts`. Typecheck and full suite pass (1048 tests).
- Browser check with playwright-cli in isolated `claude-qa` session: cross-window split lands in right window, no stray pane rows on switch, Files follows window switch, pane focus and `cd` within about 1s, no blank or reload flash on same-repo switch. Session removed after.
- Split follows pane folder. Relay `splitPane` passes `-c '#{pane_current_path}'`, deleted folder falls back to tmux default. Real tmux test added.
- "No session attached" fix: `use-repository-state.ts` and `useRepositoryQuery` gate on `attachedSession`, rerun on re-attach. Verified with three relay restarts on Changes view and one on Files view in isolated session: no error after reconnect. Full suite 1049 tests pass.
- Not committed.

### 2026-10-11 (settings tab)

- User report: desktop settings opened as a right-side Sheet and looked bad. Asked for a page that opens as a tab like files and diffs, built with the `better-*` skills.
- `main-tabs-store`: tabs are `FileTab | SettingsTab` with `kind`. `openSettings()` reuses one tab. `font-zoom.ts` treats the settings tab like the terminal.
- `settings/settings-rows.tsx`: `SettingsSection`, `SettingsRow` (wraps control under text when narrow, `textLabel` for groups and buttons), `Segmented` (native radios), `Stepper`, `SwitchRow`. `settings-panel.tsx` rebuilt on them as one page for desktop tab and phone Settings tab. New rows: file and diff text size (`codeZoom`), app theme as Light, Dark, System radios. `ThemeToggle` deleted, `@repo/ui/hooks/use-theme` re-exports `useTheme`.
- `LockSettings` and `InstallAppSection` use the same rows. Stale upstream copy fixed (tunnel, `mtmux` re-pairing, invite link) in lock settings, enroll dialog and install section.
- Shared `Switch` off state measured 1.03:1 (dark) against cards. Now `line-strong` track with `muted-foreground` thumb, 8.57:1 dark, 7.08:1 light. Selected segments use brand ring.
- Command palette Settings item pointed at removed `/settings` route. Now `open:settings`.
- Typecheck and web tests pass (476). Browser check with playwright-cli over CDP Chrome in isolated `settings-qa` session: desktop dark and light, keyboard arrows and focus outline, Ctrl+= on settings tab, rail toggle, palette, close, 860px wrap, phone tab top and bottom, enrolled lock view. Session and container removed after.
- Not committed.

