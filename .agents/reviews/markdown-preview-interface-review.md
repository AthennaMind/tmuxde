# Markdown preview interface review

Change review of the Markdown preview feature. Scope resolved by `interface-review`, domains reviewed through `better-interface` and the six `better-*` skills. 2026-10-12.

## Scope

| Field | Value |
| --- | --- |
| Target | `working`, limited to the Markdown preview feature as requested |
| Base ref | `origin/main` at `334bc7b`. `HEAD` is the merge base, 0 commits ahead |
| Head ref | working tree |
| Commits | 0 committed, 25 uncommitted paths |
| Files in scope | 12 after exclusions: `lib/markdown.ts`, `components/files/markdown-preview.tsx`, `markdown-code-block.tsx`, `repository-preview.tsx`, `repository-syntax.tsx`, `repository-syntax-tokens.ts`, `file-tab-view.tsx`, `repository-browser.tsx`, `stores/settings-store.ts`, `app/globals.css`, two test files |
| Excluded | `pnpm-lock.yaml` (lockfile); `apps/web/package.json` (manifest); icon PNGs, `icon.svg`, `favicon.ico`, deleted `app/icon.tsx`, `app/layout.tsx`, `README.md` (app icon work, not this feature). Plan and backlog read for intent only |
| Surfaces expanded | `FilePreview` consumers: `FileTabView` (desktop) and `BrowserContents` (phone), both already in scope. `commit-tab-view.tsx` shows diffs only and never passes `rendered`, not expanded |

Stack: Next.js App Router, Tailwind v4 with the `@repo/ui` token layer in `packages/ui/src/globals.css`, lucide icons, Shiki. Conventions read: `CLAUDE.md`, `.agents/plans/markdown-preview.md`, its backlog. Stated intent held against: toggle with `aria-pressed`, 44 px phone header targets, semantic tokens only, visible focus, centered logo blocks survive, full path in `title`.

## Coverage

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Names on toggle, copy, region, file links, image notes. Tab walk through summary, file link, anchor, external link, image link with computed outlines. Hit areas on desktop and phone. Global reduced motion guard, no new motion | 1 finding |
| Layout | Logical properties in `.markdown-body`. Phone 390 and 320 wide: document and region overflow, body padding, image cap, code block scroll. Image sizing against the sanitizer schema | 2 findings |
| Writing | Toggle and copy labels, image notes, loading and error copy, notice reached by link-opened images | 2 findings |
| Typography | Computed size, weight and family of h1 to h6, body measure, line heights, code sizes, inline code | 2 findings |
| Colors | Seven token pairs computed from `packages/ui/src/globals.css` in both schemes. All semantic tokens | Clear |
| UI | Code block surface, radius, copied state cue (icon plus label), image note treatment, no new transitions | Clear |

## Findings

| Severity | Domain | Status | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- | --- |
| MEDIUM | Layout | Introduced | `apps/web/src/components/files/markdown-preview.tsx:135`, `:314` | `img` override takes `src`, `alt`, `title` only. `<img width="112">` in README renders 512 px on desktop and 340 px on a phone | Pass `width` and `height` from the sanitized props into `MarkdownImage` and `LocalImage`, then onto `<img>` | GitHub's schema keeps `width` and `height`, the override drops them. Plan says centered logo blocks survive. Every README logo now fills the column and pushes content a screen down on the phone. Known dimensions also reserve space before the blob loads |
| MEDIUM | Writing | Introduced | `apps/web/src/components/files/repository-preview.tsx:141`, reached from `file-tab-view.tsx:108` and `repository-browser.tsx:419` | Link to `icon-192.png` opens a tab that says "Image preview is unavailable for symbolic links." | Treat unknown `size` as unknown: skip the symlink notice when `size` is undefined and let `ImagePreview` run. Keep the notice for the tree, where `files-view.tsx:202` can pass an explicit symlink marker | Link-opened files carry no `size`. The notice states a falsehood about a regular file and names no way forward. Verified in the browser on desktop |
| MEDIUM | Writing | Introduced | `apps/web/src/components/files/markdown-code-block.tsx:32` | `copyText(text).then((ok) => setCopied(ok))`. On `false` nothing changes | `if (!ok) useAlertStore.getState().push("error", copyFailureReason())`, as `app/(terminal)/layout.tsx:273` and `sidebar/session-tree.tsx:196` do | Copy failed in the headless check and the button stayed "Copy" with no status. Project already has the reason text and the alert channel. Same alert also announces the result to screen readers, which an `aria-label` swap on the focused button does not |
| LOW | Typography | Introduced | `apps/web/src/app/globals.css:241` | `.markdown-body h5, h6 { font-weight: 600 }`. Rendered: h4 15.75 px weight 500 Martian Mono, h5 15 px weight 600 IBM Plex Sans | `font-family: var(--font-display); font-weight: 500; letter-spacing: -0.045em;` to match the base `h1` to `h4` rule | Child heading switches face and outweighs its parent. Hierarchy should descend |
| LOW | Typography | Introduced | `apps/web/src/components/files/markdown-preview.tsx:179`, `app/globals.css:192` | `container-prose` (46 rem) with 15 px body. Measured 656 px text column, 7.26 px mean glyph, 90 characters per line | `max-width: 40rem` on `.markdown-body`, about 77 characters | Long form cap is 60 to 75 characters. Code blocks and tables keep their own horizontal scroll, so the narrower column costs them nothing |
| LOW | Layout | Introduced | `apps/web/src/app/globals.css:298` | `input[type="checkbox"] { margin: 0 0.5em 0 0 }` | `margin-inline-end: 0.5em` | Only physical property in a block that otherwise uses logical ones. Mirrors wrong in RTL |
| LOW | Accessibility | Introduced | `apps/web/src/components/files/markdown-code-block.tsx:27`, `:35` | Copy button 64 by 28 px on every pointer | `pointer-coarse:h-11` on the header and `pointer-coarse:h-10` on the button, the idiom from `terminal/recent-photos.tsx:163` | Touch target aim is 44 px. The phone header toggle meets it, the only in-content control does not |

## Pre-existing

| Severity | Domain | Location | Issue |
| --- | --- | --- | --- |
| MEDIUM | Accessibility | `apps/web/src/components/files/file-tab-view.tsx:184`, `repository-browser.tsx:371` | Pressed state of header toggles is icon color only. Background transparent in both states, verified. The new Render Markdown toggle inherits it from `HeaderButton` and the Wrap button pattern. `aria-pressed:bg-accent aria-pressed:text-foreground` on `HeaderButton` fixes both toggles at once. Content itself shows rendered or source, so not color alone in practice |

## Verification

Passed:

- Source: full diff plus five new files read. `-` side searched for removed signals. Only hit: Wrap lines button moved into a conditional, still present whenever lines exist. Not a regression.
- Contrast computed from oklch tokens, light and dark: muted-foreground on background 6.89 and 8.72, primary on background 5.57 and 13.60, foreground on muted 12.29 and 15.22, muted-foreground on surface-sunken 6.04 and 8.83, text-strong on surface-sunken 14.72 and 17.81. All pass 4.5:1.
- Rendered, Chrome 124 headless in `zenika/alpine-chrome` over CDP, playwright-cli, isolated tmux session `md-review`, scratch `.cache/md-review/sample.md`, all removed after. Desktop 1440 wide: README logo 512 px with `width` dropped, logo centered by `align`, headings h1 26.25 px to h4 15.75 px weight 500, h5 and h6 15 px weight 600 sans, 90 characters per line, Shiki tokens colored in `ts` block, copy button 64 by 28, `.markdown-table` and `pre` `overflow-x: auto`, footnote ids prefixed once, region `role="region"` named "Rendered Markdown". Tab walk: summary, file link button, anchor, external link, image link all receive the 2 px brand outline. Toggle off shows source view and Wrap lines, toggle on hides Wrap. Image link opened a tab with the symlink notice. Copy click left "Copy" with no alert.
- Phone 390 by 844 and 320 by 568: no document or region overflow, Render Markdown 44 by 44, Back 69 by 44, body padding 20 px, image capped at column width, `pre` scrolls 3 px at 320, zoom surface present.
- Tests: `docker compose run --rm tools pnpm test apps/web/src/lib/markdown.test.ts apps/web/src/components/files/markdown-preview.test.ts`, 57 passed.

Not verified:

- Wide table horizontal scroll on the phone. Sample table fit at 320 px, so only the computed `overflow-x: auto` was seen.
- Phone file link navigation to another preview.
- Proposed fixes were traced in source, not run.

## Verdict

Approve. No HIGH findings. Three MEDIUM and four LOW stay as work to do.

## Applied, 2026-10-12

All seven findings and the pre-existing toggle state fixed on request after the review.

| Finding | Change | Verified |
| --- | --- | --- |
| Image `width` and `height` dropped | `markdown-preview.tsx`: `img` override passes both through `MarkdownImage` and `LocalImage` onto `<img>` | README logo renders 112 by 112 with `width="112"` |
| Symlink notice for link-opened images | `FilePreview` takes `symlink?: boolean`. Tree hosts (`files-view.tsx`, `repository-browser.tsx`) pass `entry.type === "symlink"`. `FileTab` and `RepositoryView.preview` carry it. Unknown `size` now loads the image, the 10 MB gate applies only to a known size | Image link opens `icon-192.png`, image 192 by 192 complete, no notice |
| Silent copy failure | `markdown-code-block.tsx` pushes `copyFailureReason()` through `useAlertStore` when `copyText` returns false | Source. Headless clipboard refusal path not re-run |
| h5 and h6 face and weight | `globals.css`: display family, weight 500, letter-spacing matching base `h1` to `h4` | h4 and h5 both Martian Mono weight 500 |
| 90 characters a line | `container-prose` dropped from the article. `.markdown-body` carries margin, width, `max-width: 40rem`, gutter padding | 560 px text column, 77 characters a line |
| Checkbox physical margin | `margin: 0; margin-inline-end: 0.5em` | Rendered margin-right 7.5 px, left 0 |
| Copy hit area on touch | `pointer-coarse:h-11` header, `pointer-coarse:h-10` button | Source. Fine pointer still 28 px, coarse pointer not emulated |
| Pre-existing: pressed toggle color only | `aria-pressed:bg-accent aria-pressed:text-foreground` on `HeaderButton` and both phone toggles | Pressed Render Markdown background is `accent`, was transparent |

Checks: `pnpm typecheck` clean across workspaces, `pnpm test apps/web` 48 files, 694 tests passed. Browser re-check in the same headless Chrome setup, desktop width only.
