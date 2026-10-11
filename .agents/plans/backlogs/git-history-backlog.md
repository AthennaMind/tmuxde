# Git history backlog

Plan: [../git-history.md](../git-history.md)

## Progress summary

| Phase | Status |
| --- | --- |
| 1. Protocol and relay | [x] |
| 2. Desktop sidebar and commit tab | [x] |
| 3. Mobile repository browser | [x] |
| 4. Verification | [x] |

## How to resume

Read the plan. Check the boxes below against `git status` and the files named. Run `docker compose run --rm tools pnpm test` and `pnpm typecheck` before picking up the next open task.

## Phase 1. Protocol and relay

- [x] `packages/protocol/src/repository.ts`: `log` and `show` actions, `skip`, `commit`, result kinds
- [x] `packages/protocol/src/repository.test.ts`
- [x] `packages/protocol/PROTOCOL.md`
- [x] `apps/relay/src/repository-service.ts`: `log` and `show`
- [x] `apps/relay/src/repository-log.test.ts`: paging, unborn branch, renames, merges, root commit, denied paths, bad ids
- [x] `apps/relay/src/wire-connections.ts`: `repo:history` feature

## Phase 2. Desktop

- [x] `stores/ui-store.ts`: `history` sidebar view
- [x] `stores/main-tabs-store.ts`: `CommitTab`, `openCommit`, restore check, diffs group, tests
- [x] `components/files/commit-diff.ts` patch parser with tests
- [x] `components/files/commit-log.tsx`: shared list and data hook
- [x] `components/files/commit-view.tsx`: shared commit body
- [x] `components/files/commit-tab-view.tsx`
- [x] `components/sidebar/history-view.tsx`, rail button in `workspace-sidebar.tsx`
- [x] `components/terminal/main-tabs.tsx` and `terminal-workspace.tsx`

## Phase 3. Mobile

- [x] `repository-history.ts` view model: `history` tab and commit preview
- [x] `repository-browser.tsx`: History tab, list, commit body

## Phase 4. Verification

- [x] Tests, typecheck, build
- [x] Self review against better-* skills
- [x] Browser check. Host Chromium lacks libraries purged on 2026-10-10, so the check ran in a throwaway `zenika/alpine-chrome` container driven over CDP (`browser.cdpEndpoint` in a temp playwright-cli config).

## Session notes

### 2026-10-11

- Phase 1: `log` and `show` repository actions, `repo:history` feature, protocol docs, relay tests. Signature test proves plain Git tries the configured GPG program and the history flags stop it. Tools container mounts `/tmp` noexec, so the test reads Git's attempt from stderr too.
- Phase 2: History sidebar view and rail button, commit tabs (bulk "Close diffs" includes them), commit body with file list, sticky file headers, old and new gutters, syntax colors, large files behind "Show diff".
- Phase 3: History tab in the phone repository browser, commit view with back navigation through the browser history model.
- Verified end to end over the live relay WebSocket with an isolated tmux session: log pages, show with stats, merge against first parent, unknown commit error. 1193 tests, typecheck and build pass.
- Open: browser check of the UI once Chromium runs again.
- Sidebar drag lag with History open. CPU profile showed every resize frame re-rendering the whole sidebar view (`WorkspaceSidebar` read `sidebarWidth`), with `CommitRow` the largest cost. With a big commit tab open, layout and style of every diff line dominated. Fixes: `SidebarPanel` owns the width so views pass through as `children`; `CommitRow` memoized; `content-visibility: auto` on commit rows and on each open file diff. Measured over 40 drag steps in headless Chrome: History 3586 ms script to 335 ms; History with the 79 file merge open 10.0 s to 4.3 s total, layout 2767 ms to 652 ms.
- Pane switch within one folder refetched context, status, every open folder listing and the log. Repository state now watches the active pane's folder only, keys context and status by folder, and leaves the pane out of query keys for absolute paths. `repositoryRequest` sends absolute path requests through the active pane, so a pane saved with a tab or closed since cannot fail them. Measured in headless Chrome: same folder switch went from 4 requests and 20 DOM mutations (Files) to none.
