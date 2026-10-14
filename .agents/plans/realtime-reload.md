# Realtime reload

The IDE surfaces should follow the working tree and the repository as they change, without waiting for a poll. Today one 15 s status poll runs only while the desktop sidebar shows Files, Changes or History. Listings, open file tabs and the phone browser never reload on their own. Nothing watches `.git` or the worktree.

## Research summary (2026-10-14)

| Surface | Reload today | Source |
| --- | --- | --- |
| Context and status | 15 s `setInterval` plus every window `focus`, only while sidebar is on Files, Changes or History and visible | `ui/src/components/sidebar/use-repository-state.ts:36,171-182`, `workspace-sidebar.tsx:111-118` |
| History first page | piggybacks on the status answer (`tick`) | `files/commit-log.tsx:55-57,110`, `sidebar/history-view.tsx:22-23` |
| File tree listings | manual "Refresh files", re-attach or remount only | `sidebar/files-view.tsx:252-258,343-350` |
| Change markers in the tree | derived from status, so 15 s | `files-view.tsx:117-138` |
| File and diff tabs | activation, Reload button, re-attach | `files/file-tab-view.tsx:88-93,132-144` |
| Phone repository browser | manual refresh only, no poll, does not follow `cd` in the same pane | `files/repository-browser.tsx:90,149,155,312` |
| Monaco editor overlay | sends `file:watch` with a file path. The Go server accepts directories only, answers `WATCH_FAILED` "Not a directory", and the UI shows an error toast. Handler also captures stale `isModified` | `files/file-editor.tsx:114-126,146-155`, `internal/node/files/watch.go:91-93` |
| `useVisibleInterval` | exists, unused | `hooks/use-visible-interval.ts` |

Server facts: `file:watch` is one fsnotify instance per directory, depth 0, 32 per connection, lost on reconnect (`internal/node/local/files.go:148-185`, `local.go:279,291`). Timing in `files/service.go:51-56`: 100 ms atomic delay, 50 ms change throttle. Every `repo:request` costs a tmux `list-panes`, a `.git` metadata walk and git processes, so reloads must be coalesced. Hub inbound limit is 100 frames per second (`internal/hub/ws/ws.go:62`). Vendored fsnotify is v1.10.1 without public recursive watching, so the repository watcher adds one watch per directory on one fsnotify instance. inotify limits on the dev host: 503087 watches, 128 instances.

## Design

One server side repository watcher per connection and repository root. It watches the git directory and the worktree, coalesces events and pushes one `repo:changed` message. The UI keeps a slow visibility aware poll as a safety net and reloads the affected surfaces on push.

## Protocol

Four new message types. Feature `repo:watch` in `auth:success.features` gates the UI. Update `packages/protocol/PROTOCOL.md` including the type counts on line 8.

Client:

- `repo:watch { type, id: string (pane, min 1), path?: string }`. Ownership rule and discovery as `repo:request` (`internal/node/local/files.go:216-243`, `repo/paths.go:232`). `path` is the captured context path like other repo actions. Empty or relative `path` is denied.
- `repo:unwatch { type, root: string }`.

Server:

- `repo:watch:result { type, root: string | null, ok: boolean, partial: boolean, message?: string }`. `ok` false with a short message when the pane directory is not a repository, discovery fails, the watcher cap is hit or the watch cannot start. `partial` true when the directory cap or the walk time cap was hit, so the client keeps the normal poll.
- `repo:changed { type, root: string, git: boolean, paths: string[], truncated: boolean }`. `paths` are worktree paths relative to `root`, forward slashes, deduped, sorted, at most 64. `truncated` true when more changed. `git` true when the git directory changed (HEAD, index, refs, packed-refs, MERGE_HEAD and so on). Git directory paths never appear in `paths`.

Checklist: Zod schemas in `client-messages.ts` and `server-messages.ts` unions, Go structs with registry entries in `internal/protocol/client` and `internal/protocol/server` (first field `Type`, `WireType`, `Validate`), fixtures `fixtures/client/repo.watch.json`, `repo.unwatch.json`, `fixtures/server/repo.watch.result.json`, `repo.changed.json`, invalid cases for constrained fields, feature list in `internal/hub/ws/ws.go:80` and its pinned copies (`unit_test.go:160`, `helpers_test.go:39`, `fixtures/server/auth.success.json`, `fixtures/invalid/server/auth.success.json`), handlers in `internal/node/local` and `ui/src/hooks/use-websocket.ts`.

## Server

New file `internal/node/repo/watch.go` in package `repo`, since it needs `discover`, `openRepository` and the guard.

- `(*Service).Watch(ctx, cwd, path, send func(server.RepoChanged)) (*Watcher, Result)`: resolve the repository exactly like `handle` does for `status`. Linked worktrees: HEAD and index live in the gitdir, refs in the common dir. Watch both.
- Git directory: depth 0 of gitdir and commondir, filtered to `HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REBASE_HEAD`, `index`, `packed-refs`, plus `refs` recursively (bounded, it is small). Ignore `*.lock` and the editor temp patterns from `files/watch.go:69`.
- Worktree: walk from root, add every directory, never follow symlinks, skip any `.git` entry, skip directories listed by `git ls-files --others --ignored --exclude-standard --directory -z` run with the same safe env and argv prefix as the other git calls (`git.go:31-50,117`). Cap at 4096 directories and 5 s walk time, then stop adding and set `partial`. Remember the ignored prefixes. On `Create` of a directory not ignored, add it and its subtree within the cap. Removed directories drop out with inotify.
- Events map to relative paths. Worktree events add a path, git directory events set `git`. Coalesce with a 250 ms trailing debounce and a 1 s maximum wait from the first event, dedupe and sort, cap at 64 paths with `truncated`. Send through the connection context like `FileChanged` (`local/files.go:162-167`).
- Limits: 4 repository watchers per connection, a duplicate root re-acks `ok` and does nothing. All close in `Node.Close`.
- Router: `repo:watch` and `repo:unwatch` cases in `internal/node/local/router.go:245` area with the ownership rule from `repoRequest`. Guard everything with `checked`. Errors reply `repo:watch:result` with `ok: false`, never an `error` frame, so the UI can fall back quietly.
- Tests in `internal/node/repo/watch_test.go` with a temp repository: create a file gives one `repo:changed` with the path; `git add` and `git commit` set `git`; a directory listed in `.gitignore` produces nothing; a new directory gets watched; the cap sets `partial`; a non repository answers `ok: false`; unwatch stops events; coalescing turns a burst of 200 writes into one message with `truncated`; closing the connection closes the watcher. Router tests for ownership and the cap.

## UI

New store `ui/src/stores/repo-watch-store.ts`: `roots: Record<string, {ok, partial}>`, `lastChange: {seq, root, git, paths, truncated} | null`, `applyResult`, `applyChange`, `reset` on disconnect. `use-websocket.ts` feeds it. Pure helpers in `ui/src/lib/repo-change.ts` with tests: `changeTouchesFolder(change, root, folder)` (a path in the folder or a truncated change), `changeTouchesFile(change, root, file)`.

- `use-repository-state.ts`: when attached, the feature is present and context has a `root`, send `repo:watch` for the active pane and context path. Re-send on reconnect (`attachCount`) and when the root changes, `repo:unwatch` the old root. Keep the watch while the sidebar is collapsed, the rail badge should stay fresh. On `repo:changed` for the current root, refresh status silently with a 200 ms debounce and never more than one status request in flight. Replace the 15 s `setInterval` with `useVisibleInterval`: 15 s while the watch is missing or partial, 120 s while it is healthy. Keep the `focus` wake, add the `visibilitychange` wake the hook provides.
- `sidebar/files-view.tsx` `FolderChildren`: reload a folder listing silently (`keepPrevious`) when a change touches it.
- `files/commit-log.tsx`: the first page already refreshes on a new status object. Keep that and make sure a `git` change leads to a status refresh, so History and Graph follow commits.
- `files/file-tab-view.tsx`: reload silently when a change touches the tab path, or when `git` changes for staged and unstaged diff tabs. Keep the manual Reload button.
- `files/repository-browser.tsx` (phone): subscribe to the same store and bump its refresh silently. Include the pane folder in the context key so a `cd` in the same pane is followed. Add the watch there too when the desktop sidebar is not mounted.
- `files/file-editor.tsx`: watch the parent directory, match the event by file name under that directory, read the pending state through refs, and show the "File changed on disk" banner when there are unsaved edits. Drop the error toast path for `WATCH_FAILED` from the editor.
- No spinners on silent reloads. Manual buttons keep their spinners.

## Tests

Vitest: store, `repo-change` helpers, protocol fixtures. Go: watcher and router tests, `go vet`, race run. Full `pnpm test`, `typecheck`, `build`.

## Browser check

Repository in the dev container scratch dir. With Files, Changes and History open: touch a file from a tmux pane and watch the listing and the Changes view update within about a second. `git add`, `git commit` and see Changes and History follow. Open a file tab, append to the file from the pane, see the tab update. Confirm a burst of writes produces one or a few reloads, not one per write. Check the phone layout with `--mobile`.

## Out of scope

Watching submodules, cross repository watches, server side status caching.
