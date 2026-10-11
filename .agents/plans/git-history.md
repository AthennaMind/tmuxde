# Git history view

Commit log of the selected pane's repository, and each commit as one inlined patch (all files in one scroll, like `git show`), not one file at a time.

## Model

Follows the pane focus model. History belongs to the repository of the active pane's folder, the same context Files and Changes use. A commit opens as a main-area tab beside files and diffs. Commits are immutable, so a commit tab never needs a reload.

## Protocol

No new message type. `repo:request` gains two actions. New relay feature `repo:history` in `auth:success.features` gates the UI, so an older relay never sees an action it would reject.

- `log`: `path` (captured context), optional `skip`. Answers `{ kind: "log", root, branch, skip, commits, more }`. Page size 100. `commits[]` is `{ hash, parents, author, date, subject, refs }`.
- `show`: `path`, `commit` (7 to 64 lowercase hex). Answers `{ kind: "show", root, commit, files, hidden, truncated }`. `commit` adds `email`, `committer`, `committerDate`, `body`. `files[]` is `{ path, originalPath?, status, additions, deletions, binary, patch }`. `hidden` counts files denied by file policy.

## Relay

`repository-service.ts`.

- `log`: `git rev-parse --verify -q HEAD` first, so an unborn branch answers an empty page. Then `git log --no-show-signature --no-mailmap --no-notes -z --format=<fields> -n 101 --skip N --end-of-options HEAD`.
- `show`: resolve `<commit>^{commit}` with `rev-parse --verify`. Metadata from `git show -s` with the same safety flags. Patch from one `git diff-tree -r -z -M --root --raw --numstat -p --diff-merges=first-parent --no-ext-diff --no-textconv --no-color`. Raw gives status, numstat gives counts, patch sections pair by index because all three come from one diff queue.
- Every file path (both sides of a rename) passes `checked()`. Denied files drop from `files` and count in `hidden`, matching how `status` hides them.
- Existing limits hold: 5 s per Git command, 512 KiB output, 2,000 entries.

## Web

- Sidebar view `history` with rail button. List of commits, keyboard roving like the session tree, "Load more" paging, silent first-page refresh on the status poll.
- `CommitTab` in `main-tabs-store` (`kind: "commit"`, id `commit:<hash>`). Bulk "Close diffs" includes commits.
- `CommitTabView`: header bar, commit meta (subject, body, author, dates, hash, parents, refs), file summary that jumps to sections, then every file as a section with sticky header, old and new line gutters and syntax colors.
- Mobile repository browser gains a History tab that reuses the list and the commit body.

## UI rules

Built against `.agents/skills/better-*`: native buttons, roving tabindex in the list, visible focus, names on icon buttons, status letters with text labels (never color alone), tabular numbers on counts, truncation with full value in `title`, sentence case, verb-first buttons, empty states that point forward, semantic color tokens only (`term-added`, `term-removed`, `signal-*-surface`, `muted`).

## Out of scope

Branch picker, file history (`log -- path`), graph lines, search, checkout or any write.
