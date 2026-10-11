# Desktop chrome rework

Created 2026-10-10. Companion backlog: [backlogs/desktop-chrome-rework-backlog.md](backlogs/desktop-chrome-rework-backlog.md).

## Goal

Desktop stacks three bars above terminal: global header, terminal toolbar, window strip. Global header carries no unique information. Collapse chrome to one bar above terminal and give the height back to the terminal. Mobile layout stays unchanged.

## Problems in current layout

- Session name `dev` appears four times: header tab, toolbar title, sidebar card, tmux status line.
- New session `+` appears in header and sidebar.
- `tmuxde` wordmark repeats browser tab title.
- `Machine` switcher has no name in local token mode. No machines are paired, so it opens an empty sheet.
- Connection label shows Docker container id as hostname.
- Theme toggle duplicates Settings.
- Sidebar collapse button sits alone in its own row. Sidebar and main column borders do not line up.
- Desktop gear calls `router.push("/settings")`. Route was removed in `260f471`, so it 404s.

## Target layout

```
sidebar                              main
[<] Sessions          [refresh][+] | [1 bash][2 bash][3 bash] [+] [panes]  (alert)  [Photo][Recent]  [Files][Search]  [- 17 +][Fullscreen][Settings]
  dev                              | terminal
  ...                              |
[*] Connected 12ms     [Machine]   |
```

- Sidebar header and main bar share 44px row height so borders align.
- Collapsed sidebar keeps expand button at top and status dot at bottom. Main bar shows session name only while sidebar is collapsed.
- Action groups use `gap-1` inside and `gap-4` between groups (layout skill 2x rule).
- Connection and capability banners render in AppShell header, hidden when empty, so they still push terminal down.
- Settings opens `SettingsPanel` in right sheet on desktop.

## Files

- `apps/web/src/app/(terminal)/layout.tsx`: drop desktop header row, keep banners, mount `MachineSwitcher` sheet.
- `apps/web/src/components/terminal/terminal-workspace.tsx`: sidebar header and footer, one main bar, settings sheet.
- `apps/web/src/components/terminal/terminal-toolbar.tsx`: becomes main bar with window strip and grouped actions.
- `apps/web/src/components/session/session-list.tsx`: `leading` slot for collapse button.
- `apps/web/src/components/machines/machine-switcher.tsx`: hide trigger when no machine is paired.
- `packages/ui/src/components/connection-status.tsx`: hostname only in tooltip and screen reader text.
- `packages/ui/src/components/app-shell.tsx`: hide empty header.
- `apps/web/src/components/session/session-tabs.tsx`: delete.

## Out of scope

- Hiding touch only settings sections (keyboard toolbar, gestures, haptics) on desktop.
- Mobile chrome.
