# Markdown preview backlog

Plan: [../markdown-preview.md](../markdown-preview.md)

## Progress summary

| Phase | Status |
| --- | --- |
| 1. Dependencies | [x] |
| 2. Pure helpers and tests | [x] |
| 3. Shiki by language | [x] |
| 4. Preview component and styles | [x] |
| 5. Hosts: toggle, setting, link navigation | [x] |
| 6. Verification | [~] |

## How to resume

Read the plan. Check the boxes below against `git status` and the files named. Run `docker compose run --rm tools pnpm test apps/web` and `pnpm typecheck` before picking up the next open task. If the dependency helper failed, run `docker compose up -d --no-build --wait web relay` and check `docker compose ps`.

## Phase 1. Dependencies

- [x] `python3 .docker/dev/dependencies.py mutate --filter @app/web add react-markdown remark-gfm`
- [x] react-markdown 10.1.0 and remark-gfm 4.0.1 in `apps/web/package.json` and `pnpm-lock.yaml`, web and relay healthy

## Phase 2. Pure helpers

- [x] `apps/web/src/lib/markdown.ts`: `isMarkdownPath`, `splitFrontMatter`, `resolveMarkdownHref`, `resolvePath`, `createSlugger`, `hastText`, `codeBlockLanguage`
- [x] `apps/web/src/lib/markdown.test.ts`

## Phase 3. Shiki by language

- [x] `repository-syntax-tokens.ts`: `resolveCodeLanguage`, `highlightCodeByLanguage`, shared `withinBounds`, `loadLanguage`, `tokenizeWith`
- [x] `repository-syntax.tsx`: `useCodeSyntax(language, source)` deferred like `useRepositorySyntax`

## Phase 4. Preview component

- [x] `components/files/markdown-code-block.tsx`: language label, copy, Shiki tokens
- [x] `components/files/markdown-preview.tsx`: links, images, headings, front matter, task lists, tables, inline HTML through `rehype-raw` and `rehype-sanitize`
- [x] `components/files/markdown-preview.test.ts`: hostile input inert, safe html kept, link kinds, heading ids, code, front matter, GFM, footnote ids, images
- [x] `app/globals.css`: `.markdown-body` in `@layer components`
- [x] `repository-preview.tsx`: `rendered` and `onOpenPath` props, `next/dynamic` import

## Phase 5. Hosts

- [x] `stores/settings-store.ts`: `markdownPreview` default on, `setMarkdownPreview`
- [x] `file-tab-view.tsx`: Render Markdown toggle, Wrap hidden while rendered, `openFile` for links
- [x] `repository-browser.tsx`: same toggle at 44 px, `navigate` to preview for links

## Phase 6. Verification

- [x] Tests, typecheck, build
- [x] Interface review against better-* skills, 2026-10-12. Findings in [../../reviews/markdown-preview-interface-review.md](../../reviews/markdown-preview-interface-review.md)
- [x] Fix review findings: `width` and `height` on images, symlink notice for link-opened images, copy failure feedback, h5 and h6 face, checkbox margin, copy hit area on touch, pressed toggle background. 2026-10-12
- [x] Browser check on desktop by the author, 2026-10-11

## Session notes

- 2026-10-11: Plan and backlog written. Survey found no existing markdown rendering, `FilePreview` as the single live render path, Shiki singleton private, images only through HTTP `/file` with bearer token.
- 2026-10-11: Phases 1 to 5 implemented. File links render as buttons, not anchors, so a middle click cannot open a dead route. Known edge: a file opened from a link has no `size`, so an image target would show the symlink notice.
- 2026-10-12: Interface review done, verdict Approve with 3 MEDIUM and 4 LOW. Rendered check in headless Chrome on desktop and phone widths, 57 tests pass.
- 2026-10-12: All review findings fixed. `FilePreview` gained `symlink`, carried on `FileTab` and `RepositoryView.preview`, so a file opened from a Markdown link with unknown size loads instead of claiming a symlink. Typecheck clean, 694 web tests pass, fixes re-checked in the browser on desktop. Work stays uncommitted.
- 2026-10-11: Inline HTML added after the author found the README logo block missing. `rehype-raw` plus `rehype-sanitize` with GitHub's schema. remark's `clobberPrefix` set to empty so the sanitizer is the only one prefixing ids. Anchor scrolling tries the bare and prefixed id.
