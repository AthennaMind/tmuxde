# Desktop chrome rework backlog

Plan: [../desktop-chrome-rework.md](../desktop-chrome-rework.md).

## Progress

| Phase | Status |
| --- | --- |
| 1. Single desktop bar | [x] |
| 2. Sidebar header and footer | [x] |
| 3. Settings sheet fix | [x] |
| 4. Verification | [x] |
| 5. Follow-ups | [x] |
| 6. Desktop typography | [x] |
| 7. Remaining type findings | [ ] |

## How to resume

Phases 1 to 6 are done. Work is uncommitted until reviewed. Pick up phase 7. Run `docker compose run --rm tools pnpm typecheck` and `pnpm test`. Browser check needs a CDP Chrome: host Chromium lacks `libnspr4.so`, so run local `zenika/alpine-chrome` with `--network host --remote-debugging-port=9333` and point playwright-cli config `browser.cdpEndpoint` at it. Use an isolated tmux session, never `dev`.

## Phase checklist

### 1. Single desktop bar

- [x] Remove desktop header row from `(terminal)/layout.tsx`
- [x] Keep `ConnectionBanner` and `CapabilityBanner` in header, hide empty header in `AppShell` with `empty:hidden`
- [x] Merge window strip into `TerminalToolbar`, strip sized to content so window `+` stays next to tabs
- [x] Move `AlertBanner`, photo controls into toolbar
- [x] Search floats over terminal pane through `terminalSearchOpen` store flag
- [x] Font size value doubles as reset button
- [x] Labels for Photo, Recent photos and Files collapse to icons below `@5xl` container width
- [x] Delete `session-tabs.tsx` and unused `closeSession`

### 2. Sidebar header and footer

- [x] Collapse button joins `SessionList` header through `leading` prop
- [x] `SidebarStatus` footer with connection status and machine switcher
- [x] Collapsed rail shows status dot. Terminal bar shows session name while collapsed
- [x] Hostname out of visible connection label
- [x] Hide machine trigger when no machine is paired. Sheet stays mounted for palette

### 3. Settings sheet fix

- [x] Desktop gear opens `SettingsPanel` in right sheet

### 4. Verification

- [x] Typecheck
- [x] Tests: 70 files, 1033 tests
- [x] Desktop screenshots at 1440x900 and 900x700, sidebar open and collapsed
- [x] Search, settings sheet, collapse toggle
- [x] Mobile 390x844 unchanged
- [x] No console errors

### 5. Follow-ups

- [x] Ctrl+E toggles desktop files panel. Panel state moved to `ui-store` as `filesPanelOpen`
- [x] `SettingsPanel touch={false}` on desktop hides keyboard toolbar, gestures, haptics, auto-zoom. GPU rendering shows only there
- [x] Window strip fades whichever edge hides tabs. Scroll and ResizeObserver driven
- [x] Narrow terminal column: zoom and fullscreen hide below `@3xl`, actions wrap instead of crushing tabs

### 6. Desktop typography

- [x] Terminal uses mobile metrics everywhere: weight 500, bold 600, line height 1.15, contrast floor 4.5, brightened dim text
- [x] DOM renderer default on desktop. `gpuRendering` defaults off, persist version 1 migrates stored `true`
- [x] `text-code` and `text-code-meta` utilities in `app/globals.css`. Phone sizes by default
- [x] Desktop files panel raises code to 13px, line height 1.6, path 12px, weight 500 in dark mode
- [x] Code drops inherited body tracking
- [x] Cascadia Code v2407.24 variable woff2 vendored in `public/fonts` with OFL license and NOTICE entry
- [x] `--font-mono`, terminal default, Monaco editor use Cascadia Code. Retired font defaults map to it at use time
- [x] Code Weight setting (Regular, Medium, Semibold, Bold), default Semibold. Drives terminal, file and diff views (`--code-weight` on root) and Monaco

### 7. Remaining type findings

- [ ] `packages/ui/src/globals.css` headings: Martian Mono with `-0.045em` tracking also hits 14px headings such as `Sessions` and settings sections. Scope negative tracking to large sizes
- [ ] `packages/ui/src/globals.css` body: `cv02`, `cv03`, `cv04` are Inter tags with no effect on IBM Plex Sans
- [ ] `settings-panel.tsx` hints at `text-[10px]`, below 12px floor

## Session notes

- 2026-10-10: Plan written. Desktop chrome cut from three rows (about 136px) to one 44px row. Sidebar header and terminal bar share a row with aligned borders. Connection status moved to sidebar footer. Settings gear fixed (was routing to removed `/settings`). Verified in browser at desktop and phone widths.
- 2026-10-11: Follow-ups fixed. Desktop terminal and code viewer typography matched to mobile. Verified at DPR 2 in browser: terminal on DOM renderer, desktop diff 13px/1.6/500, phone diff unchanged at 12px/20px/400. Typecheck and 1033 tests pass.
- 2026-10-11: Switched all code surfaces to Cascadia Code with a Code Weight setting. User confirmed the look in their own browser. Typecheck and 1034 tests pass.
