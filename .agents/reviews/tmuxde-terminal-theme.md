# tmuxde terminal themes

Date: 2026-10-11. Built and reviewed with `better-colors`, then a `better-interface` pass across all six `better-*` skills. Light palette added the same day.

## What changed

- `packages/ui/src/terminal-themes.ts`: two palettes, `tmuxdeDark` and `tmuxdeLight`. The stored id `tmuxde` is no longer a palette. It means "Match app" and resolves to dark or light from the app's resolved scheme. `getTerminalTheme(name, scheme)` now requires the scheme. Unknown names fall back to the matching tmuxde palette.
- `apps/web/src/components/terminal/terminal-view.tsx`, `apps/web/src/lib/xterm-factory.ts`: pass next-themes `resolvedTheme` into xterm on creation and on change. Flipping App theme recolors a live terminal with no reload.
- `apps/web/src/components/settings/settings-panel.tsx`: picker starts with `Match app` (previews the palette showing now), then `tmuxde Dark` and `tmuxde Light`, then the named themes.
- `apps/web/src/stores/terminal-store.ts`: default is `tmuxde`. Store version 2 moves a saved `dracula` (old default) to `tmuxde`. Other picks stay.
- `apps/web/src/lib/theme-contrast.test.ts`: per palette, checks every token-derived hex against its token (within 1 per channel). Checks every text color at 4.5:1 or better on the background. Checks the ink color on every color fill (black text in dark, white text in light). Checks cursor and selection pairs and the Match app resolution.
- `apps/web/src/stores/terminal-store.test.ts`: migration tests.
- Font family, size, weight and line height are untouched.

## Palettes

Same role, same token in both schemes where the app has one. Bright steps away from the background: lighter in dark, darker in light, the same direction `--brand-hover` moves. Contrast is WCAG on the palette's own background.

| Role | Source | Dark | Light |
| --- | --- | --- | --- |
| background | `--surface-base` | `#0a0b0a` | `#fafcfa` |
| foreground | `--text` | `#eae7de` 15.94 | `#2b2f2a` 13.20 |
| cursor, selection | `--brand` / `--brand-contrast` | `#a6e96b` / `#0a0b0a` 13.60 | `#437200` / `#f6f9f6` 5.43 |
| black | dark `--line`, light `--text` | `#23281f` surface | `#2b2f2a` 13.20 |
| red | `--signal-failed` | `#f07171` 6.86 | `#be1219` 6.19 |
| green | `--signal-done` | `#a6e96b` 13.60 | `#067132` 5.96 |
| yellow | `--signal-blocked` | `#f0b65c` 10.84 | `#865901` 5.92 |
| blue | terminal only | `#6db3fa` 8.90, `oklch(0.75 0.125 250)` | `#0c62b7` 5.91, `oklch(0.5 0.153 254)` |
| magenta | `--signal-agent` | `#b79ceb` 8.42 | `#7148b0` 6.26 |
| cyan | `--signal-stalled` | `#7ccfd9` 11.06 | `#02717a` 5.59 |
| white | dark `--text`, light `--line-subtle` | `#eae7de` 15.94 | `#e2e6e1` surface |
| brightBlack | `--text-subtle` | `#9aa18c` 7.37 | `#656b63` 5.31 |
| bright red to cyan | same hue, terminal only | 9.38 to 14.02 | 7.59 to 8.55 |
| brightGreen | dark `--brand-hover`, light hue 150 | `#bcf287` 15.20 | `#075a28` 8.14 |
| brightWhite | dark `--text-strong`, light `--surface-raised` | `#f4f2ec` 17.61 | `#ffffff` surface |

Choices made from measurement:

- Light blue sits at hue 254, not dark's 250. At 250 light blue clipped to chroma 0.136 and sat ΔE_ok 0.097 from cyan. At 254 it is 0.120 from magenta and 0.116 from cyan.
- Light `white` started as `--line`. White text on color fills measured 3.98 to 4.45:1. Moved to `--line-subtle`, which gives 4.56 to 5.11:1. The test suite fails on the old value.
- Light green is `--signal-done` (hue 150), not `--brand` (hue 132). That matches the green in the app's light diff view, and `--signal-done` is also the token behind dark green.

## Scope and coverage

Scope: terminal surface in dark and light at 1400x900 and 390x844, both palettes, and the Terminal theme picker. Stack: Next.js App Router, Tailwind v4, next-themes with class switching, oklch tokens in `packages/ui/src/globals.css`, xterm 5.5 DOM renderer with `minimumContrastRatio: 4.5` (`apps/web/src/lib/xterm-factory.ts:120`). Docs read: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.local.md`. Boundary: the WebGL renderer (`gpuRendering`, off by default) was not inspected.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | All text, cursor and selection pairs in both palettes. Picker uses native radios, a `2px` brand focus outline, and a check icon on the selected card. | Clear |
| Layout | Unused space beside the xterm grid in both schemes, desktop and mobile. Picker order. | Clear |
| Writing | Labels `Match app`, `tmuxde Dark`, `tmuxde Light`. `Match app` names the on state, like `System` beside it. | Clear |
| Typography | Dim text at the project's 80% opacity, bold, selection legibility. Font untouched. | Clear |
| Colors | Gamut of every value, token parity, pairwise ΔE_ok of hues, WCAG and APCA per pair, ink on fills. | Clear |
| UI | Cursor and selection match app `::selection` in both schemes. Picker radii unchanged. | Clear |

## Findings

No actionable interface findings.

## Verification

Passed:

- Tests and typecheck: `docker compose run --rm tools pnpm test` runs 74 files and 1156 tests, all passing. `pnpm typecheck` is clean.
- Drift guards: changing the dark `background` fails the token check. Changing light `white` back to `#d3d8d0` fails the token check and all six white-on-fill checks. Both files restored.
- Browser setup: isolated tmux sessions `pwtheme` and `pwlight` (both removed), driven through a CDP Chrome container.
  - Dark: xterm viewport is `rgb(10, 11, 10)`, the same as the body.
  - Light: xterm viewport is `rgb(250, 252, 250)`, the same as the body.
  - Switching App theme to Light recolored the open terminal and the `Match app` preview without a reload.
  - A cold reload in light also comes up light.
- Swatch, `git diff`, `ls --color` and selection checked in both schemes.
  - Light: xterm lifts black text on dark color fills to light text, as designed.
  - Light: white text on fills reads directly.
- Migration: a stored `dracula` at version 1 comes back as `tmuxde` at version 2.
- Mobile at 390x844: terminal, session tabs and key toolbar sit on one surface in both schemes.

Measured trade-offs, kept on purpose:

- Dark red `#f07171` is APCA Lc -47.3, below the Lc 60 preference. Fixing it needs L 0.78, which is brightRed itself.
- Dim text at 80% opacity: dark stays at 4.71:1 or above. Light drops to 3.51 to 3.97:1 for brightBlack, cyan, yellow and blue (foreground 7.02, red 4.68). Dim text is meant to be faint, and all of these stay above 3:1. Getting light dim colors above 4.5 would mean darkening the app's signal tokens.
- Black text on light color fills measures about 2.2:1 before xterm corrects it. tmux's default green status line and yellow copy mode depend on that automatic correction in light.

Outside the palette:

- Your tmux status bar uses hard-coded colors (`status-style "bg=#010409,fg=#c9d1d9"` plus catppuccin hex values). Those are 24-bit colors, so no palette changes them, and the bar stays dark in light mode. To follow the scheme, set it to `bg=default` or to ANSI color names.

Not verified:

- WebGL renderer.
- Real phone hardware, Safari and Firefox.
- App theme `System` following a live OS scheme change.

## Verdict

Approve.
