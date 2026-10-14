# Commit file filter

Filter the files of an open commit by extension or glob before the file listing. Hide `*.md`, show only `*.sh`, and so on. Client side only. The server sends every file of the commit already (`internal/node/repo/git.go:455-522` does no filtering), so this is a view concern.

## Model

The filter lives above the file list of a commit and applies to the list and to the diff sections below it. Two modes: `hide` drops matching files, `only` keeps matching files. Patterns come from a text input and from extension chips built from the commit itself. The last patterns and mode persist in settings, so the next commit opens with the same filter. Desktop commit tabs and the phone repository browser share `CommitDetail` (`ui/src/components/files/commit-view.tsx:30`, used by `repository-browser.tsx:471-477`), so both get the filter.

## Pattern language

New module `ui/src/components/files/commit-file-filter.ts`, pure, tested in the node vitest project.

- `parseFilePatterns(text)`: split on commas and whitespace, trim, drop empties, dedupe, keep order.
- A token that is a bare extension (`md`, `.md`, `.tar.gz`) means `*.md`, `*.tar.gz`.
- Glob rules: `*` matches within one path segment, `**` crosses segments, `?` one character. Escape everything else for `RegExp`. Case insensitive.
- A pattern without `/` matches the file name. A pattern with `/` matches the full repository path, with or without a leading `/`.
- `filterCommitFiles(files, {patterns, mode})` returns `{index, file}[]` with the original index into `files`. A renamed file matches when `path` or `originalPath` matches. Empty patterns return every file.
- `fileExtensions(files)` returns `{ext, count}[]` sorted by count then name. Files without an extension are not listed. Extension is the text after the last `.` of the name when that dot is not the first character.

## UI

In `FileList` (`commit-view.tsx:270-356`), add a filter row under the "N files changed" header row and before the `<details>` list. Everything in sentence case, verb first on buttons, native elements.

- Mode group: `role="group"` with two `aria-pressed` buttons "Hide" and "Only", the pattern of `repository-changes.tsx:69-98`.
- Pattern input: `<input aria-label="File patterns" placeholder="*.md, docs/**">` using the sidebar filter look (`sidebar/files-view.tsx:269-286`), Escape clears, search icon `aria-hidden`.
- Extension chips: `aria-pressed` toggle buttons labelled `.md` with the count in tabular numbers, at most 10 by count. Clicking adds or removes `*.md` in the pattern text. Chips reflect the current patterns.
- Result line as `role="status"`: "Showing 12 of 15 files" when filtering, plus a "Clear filter" button. When nothing matches: "No files match this filter." with the same button.
- Touch mode (`touch` prop) uses `min-h-11` controls, desktop `min-h-7`.
- Semantic colors only: `bg-muted`, `text-muted-foreground`, `border-input`, `focus-visible:ring-1 focus-visible:ring-ring`, `aria-pressed:bg-accent` or `bg-muted text-foreground` for pressed.

Behaviour in `CommitDetail`:

- Keep original indices. `open`, `lines`, `large`, `headerId(index)` and `jump(index)` are keyed by index into `files` (`commit-view.tsx:44-59`). Filter to `{index, file}` pairs and pass those down.
- Count, totals (`:283-295`), `allOpen` and `setAll` (`:49-51`) use visible files.
- `<details open={files.length <= 25}>` (`:308`) must not flip when the filter changes. Use state initialised from the full count and `onToggle` to sync.
- Render a `FileSection` only for visible files. Hidden sections unmount.
- `useSettingsStore` (`ui/src/stores/settings-store.ts`) gains `commitFilterPatterns: string` and `commitFilterMode: "hide" | "only"`, persisted like `wrapLines`. Check the persist `partialize` and migration shape and the tests in `settings-store.test.ts`.

## Tests

- `commit-file-filter.test.ts`: parsing, extension tokens, segment and cross segment globs, name versus path matching, case folding, renames, both modes, empty patterns, extension counts and order.
- `settings-store.test.ts`: new fields persist and default.
- Typecheck and build.

## Browser check

Open a commit with mixed file types on the development instance, type `md`, switch modes, click a chip, clear, confirm sections and jump links follow the filter, confirm the filter survives opening a second commit. Also check the phone layout with `--mobile`.

## Out of scope

Server side filtering, saved filter presets, filtering the Changes view.
