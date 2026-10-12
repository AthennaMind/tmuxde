# Markdown preview

Rendered view for Markdown files in the Files surface, on desktop file tabs and in the mobile repository browser. Source view stays one tap away.

## Model

Follows the pane focus model. A Markdown file opens from the tree, the changes list or a link inside another Markdown file, always as an absolute path under the pane's repository. Relative links and images resolve against the folder of the file being read, never against the pane directory. Diffs of Markdown files keep the line view.

## Protocol and relay

No change. Text arrives through `repo:request` `read` as today, 100 KiB cap. Images load through the HTTP `/file` route with the bearer token, the same way the image preview does. Path guards on the relay stay the only authority on what can be read.

## Rendering

- `react-markdown` with `remark-gfm`. Inline HTML goes through `rehype-raw` and then `rehype-sanitize` with GitHub's default schema plus the classes GFM output needs. Centered logo blocks, `details`, `kbd`, `br` and `img` survive. Scripts, styles, frames, event handlers, `style` attributes and unknown tags do not. `react-markdown` also strips `javascript:` and other unsafe URL schemes. This matters because the Caddy CSP allows inline scripts.
- Ids and names from inline HTML and footnotes carry the sanitizer's `user-content-` prefix. remark's own prefix is off so nothing is prefixed twice. Links keep the bare id and the preview's scroll handler tries both forms.
- Fenced code highlights through the existing Shiki singleton. `repository-syntax-tokens.ts` gains `highlightCodeByLanguage(language, source)` with the usual aliases (`ts`, `js`, `sh`, `bash`, `yml`, `py`, `rs`, `docker`, `jsonc`). Unknown languages render plain.
- Headings get GitHub style ids, so `#section` links scroll inside the preview. Slugs come from a small local function, no extra dependency.
- YAML front matter is split off and shown as a collapsed block above the body, highlighted as YAML.
- Task list checkboxes render disabled. Tables and code blocks sit in their own horizontal scroll wrapper, which also keeps the mobile swipe gesture working.
- Truncated content shows the existing "Preview shortened" banner.

## Links and images

`resolveMarkdownHref(filePath, href)` classifies every target:

- `#fragment`: scroll to the heading inside the preview.
- `http:`, `https:`, `mailto:`: open in a new tab with `rel="noopener noreferrer"`.
- Relative or absolute path: resolve to an absolute path from the file's folder. Desktop opens a new file tab through `openFile`. Mobile navigates the repository browser to that preview.
- Anything else, including `javascript:` and `data:` for links, renders as plain text.

Images use the same resolver. Local paths load through `useFileObjectUrl`. Remote images render as their alt text plus a short note, because `img-src` is `'self' data: blob:`. Without a direct HTTP connection the same note as the image preview shows.

## Web

- `lib/markdown.ts`: `isMarkdownPath`, `splitFrontMatter`, `resolveMarkdownHref`, `createSlugger`, `hastText`. Pure, tested.
- `components/files/markdown-preview.tsx`: `MarkdownPreview` with component overrides for `a`, `img`, `pre`, `code`, `h1` to `h6`, `input`, `table`. Loaded through `next/dynamic` from `FilePreview`, so the parser ships only when a Markdown file opens.
- `components/files/markdown-code-block.tsx`: block with language label, Shiki tokens, copy button.
- `repository-preview.tsx`: `FilePreview` gains `rendered` and `onOpenPath` props. Markdown with `rendered` goes to `MarkdownPreview`, else the line view.
- `stores/settings-store.ts`: `markdownPreview` boolean, default on, persisted beside `wrapLines`.
- `file-tab-view.tsx` and `repository-browser.tsx`: header toggle, shown only for Markdown files that are not diffs, and `onOpenPath` wiring.
- `app/globals.css`: `.markdown-body` rules on semantic tokens. Body text in the sans face sized with `--code-zoom`, so Ctrl with `-`, `=` and `0` scale it like code. Code keeps `text-code`.

## UI rules

Built against `.agents/skills/better-*`: native buttons with names, `aria-pressed` on the toggle, visible focus, 44 px touch targets on the phone header, semantic color tokens only, sentence case, no color as the only signal, truncation with the full value in `title`.

## Out of scope

MDX, math, Mermaid, inline styles, editing, a table of contents panel, following `file.md#fragment` into a heading of another file.
