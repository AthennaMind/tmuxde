# Git surfaces interface review

Screen review of the three git surface features: commit file filter, realtime reload, git graph. Run through `better-interface` with the six `better-*` domain skills. 2026-10-14.

## Scope and coverage

Scope is the surfaces these features add or change, read from `git status` and the three plans:

- Commit detail filter row and changed file list: `ui/src/components/files/commit-view.tsx` (`FileList`, `FileListRow`, `FileFilter`), `commit-file-filter.ts`. Desktop commit tab and the phone repository browser.
- Git graph tab: `graph-tab-view.tsx` (`GraphTabView`), `graph-list.tsx` (`GraphList`, `GraphRowItem`, `GraphCell`), the History header button (`sidebar/history-view.tsx:36`), the palette entry (`command/command-palette.tsx:271`), the tab strip entry (`terminal/main-tabs.tsx`).
- Realtime reload surfaces: Changes, Files tree, History, file tabs, phone browser and the editor banner (`file-editor.tsx`). These change data flow, not markup, apart from the editor banner path.

Boundary: the graph is desktop only by plan, so it was checked on desktop at 1440 and 900 px. The phone checks cover the filter and the phone browser. Monaco editor banner was read in source only.

Stack: Vite, React, Tailwind v4 with the token layer in `packages/ui-kit/src/globals.css` (`:root` and `.dark`), lucide icons. Conventions read: `CLAUDE.md` (semantic colors, sentence case, verb first buttons), the three plans, the backlog. No separate design system doc.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Names and roles from the snapshot tree for filter mode group, pattern input, chips, status, file rows, graph rows, graph header buttons. Keyboard: Tab through filter row and file list, arrow keys and Enter in the graph. Computed focus styles on every new control. Phone hit areas | 2 findings, 1 low |
| Layout | Filter row at 1440, 360 and 320 px (`scrollWidth` 320, nothing past the edge). Graph columns at 1440 and 900 px. Logical properties in new classes | Clear |
| Writing | Heading and status copy, empty filter state, graph notices, button labels, palette and History entry names | 1 finding, 1 low |
| Typography | Input 16 px on phone, 12 px mono on desktop. Truncation with `title` on graph subject and author. Tabular numbers on counts, ages, hashes | Clear |
| Colors | Contrast computed from `globals.css` token values in both schemes: accent or muted fill on background 1.05:1 dark and 1.08:1 light; primary border on background 13.6:1 dark and 5.57:1 light; ring on background 13.6:1; muted foreground on background 8.72:1 | 1 finding |
| UI | Pressed, selected, hover, focus and loading states of new controls. Spinner on manual refresh only, `motion-reduce:animate-none` present | Clear |

## Findings

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| HIGH | Accessibility | `ui/src/components/files/commit-view.tsx:465`, `FileListRow` | `focus-visible:bg-accent/50 focus-visible:outline-none`. Measured fill 1.02:1 on the background. Tab onto a file row shows no change in the screenshot | Add `focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring`, the idiom of the `summary` above it. **Fixed** | Keyboard reachable control with no visible focus indicator. The filter makes this list the main way to jump to a section |
| HIGH | Colors | `ui/src/components/files/commit-view.tsx:529-538`, `FileFilter` mode group | Pressed `bg-muted text-foreground`, unpressed `text-muted-foreground`. Fill 1.05:1 on the background, text pair 1.83:1. Hide and Only look nearly the same | Pressed `border-primary bg-primary/10 text-foreground`, unpressed `border-transparent`, both with `border`. Same treatment as the chips in the same row. **Fixed** | State carried by a faint color change alone. Users cannot tell whether the patterns hide or keep files |
| MEDIUM | Colors | `ui/src/components/files/graph-list.tsx:188-192`, `GraphRowItem` | Open commit marked only with `bg-accent text-accent-foreground` (1.05:1) | `border-s-2` on every row, `border-primary` when selected, `border-transparent` otherwise. `ps-2` became `ps-1.5`, so lanes stay put. **Fixed** | `aria-current` row had no visible cue in practice. Bar measured 13.6:1 dark, 5.57:1 light |
| MEDIUM | Writing | `ui/src/components/files/commit-view.tsx:386`, `FileList`; helper `commit-file-filter.ts:239` `filesChanged` | `{visible.length} files changed`. With `md` hidden the heading said "4 files changed" for an 8 file commit | `filesChanged(shown, total, filtering)` gives "4 of 8 files changed" while a filter is set and "8 files changed" otherwise. 2 tests added. **Fixed** | Heading stated a false fact about the commit. Status line below said otherwise |
| LOW | Accessibility | `ui/src/components/files/commit-view.tsx:555-556`, `FileFilter` | Input named by `aria-label="File patterns"`, visible cue is placeholder and search icon only | Leave. Same idiom as the sidebar filter (`sidebar/files-view.tsx:279`). A visible label would cost a row on the phone | Placeholder is not a label. Low impact because the icon and the chips explain the field |
| LOW | Writing | `ui/src/components/command/command-palette.tsx:271`, `ui/src/components/sidebar/history-view.tsx:36` | "Open git graph" in the palette, "Open graph" in History, tab named "Graph" | Leave. The palette has no repository context around it, so "git" helps there | Two names for one surface. Small risk |

## Pre-existing, outside the cap

- Systemic token cause: `--accent` and `--muted` both point at `--surface-panel` (`packages/ui-kit/src/globals.css:188`, `:190`), 1.05:1 on the dark background and 1.08:1 on the light one. Every pressed or selected state that relies on that fill alone is close to invisible: `files/repository-changes.tsx:89` (List and Tree), `files/commit-log.tsx:500` (History selected row), `sidebar/tree-row.tsx:163`. Fix proposal: give selected and pressed states a second cue (border or bar in `primary`), as done for the new controls. Changing the token is a design decision and was not done.
- Focus rings across the app are `ring-1` (1 px). Lime on near black measures 13.6:1, so it is visible, but under the 2 px guidance. Project wide convention, not changed.

## Verification

Passed:

- Desktop session `fvd` at 1440 by 900 on 18443, fixture `/tmp/tmuxde-dev/scratch/fv` (117 commits, branches `topic` merged and `feature` unmerged, tag `v0.1`, mixed file commit of 8 files).
- Filter: typed `md` in Hide gave "Showing 4 of 8 files". Only plus `.sh` chip gave `md, *.sh` and 5 of 8. After fixes the heading reads "5 of 8 files changed", the Only button shows a primary border, Tab onto README.md shows an inset ring (computed `box-shadow` has `oklch(0.8627 0.1721 132.3) 0 0 0 1px inset`).
- Graph: opened from History "Open graph". Lanes, merge ring, HEAD ring, ref chips and tag render. ArrowDown three times then Enter opened "Mixed files commit". Load older added 17 rows, 117 total. Selected row shows a 2 px primary bar after fix, lanes unchanged.
- Phone session `fvm` (`--mobile`, 360 and 320 px): mode buttons and chips 44 px, input 16 px, `scrollWidth` equals the viewport, Only `sh` shows "1 of 8 files changed".
- `docker compose run --rm tools pnpm test` (57 files, 1015 tests), `pnpm typecheck`, `pnpm --filter @app/ui build`: pass after fixes.

Observed, not an interface domain finding: with every commit in the same second, the first graph page puts commits 46 to 18 below "Merge topic" because their link to it lies on the next page. Order is right once that page loads. The plan accepts this trade-off since `--date-order` was dropped.

Not verified: screen reader announcement of the status region by a real screen reader, forced colors mode, editor banner in the browser.

## Verdict

Approve. Both high findings and both medium findings are fixed and checked in the browser. Two low findings stay listed.
