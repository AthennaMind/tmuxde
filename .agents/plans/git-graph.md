# Git graph

A graph view of the repository history, like the IntelliJ or VS Code Git Graph log: lanes, branch and merge lines, ref labels, every branch and tag, newest first. Opens as a main area tab beside files, diffs and commits. A row opens the commit tab.

## Model

Follows the pane focus model the same way commit tabs do. The tab captures `paneId` and `contextPath` when opened, so it stays on that repository. The History sidebar stays as it is (first parent walk of HEAD). The graph asks the same `log` action with a new `all` flag.

## Protocol

No new message type. `repo:request` gains `all?: boolean`, honoured by `log` only. Feature `repo:graph` in `auth:success.features` gates the UI.

- `packages/protocol/src/repository.ts:5-20`: add `all: z.boolean().optional()`.
- `packages/protocol/fixtures/client/repo.request.json`: sample 0 must set `all` (TS and Go both require every top level key in sample 0). Add a log sample with `all: true`. `fixtures/invalid/client/repo.request.json`: add `{field: "all", ...}` with a string value.
- `packages/protocol/fixtures/server/auth.success.json` and `fixtures/invalid/server/auth.success.json`: features list gains `repo:graph`.
- `packages/protocol/PROTOCOL.md`: request shape at 131-143, log paragraph at 150-156, features.
- Go: `internal/protocol/client/file.go:201-235` gains `All *bool \`json:"all,omitempty"\``. Feature list `internal/hub/ws/ws.go:80` plus the pinned copies in `internal/hub/ws/unit_test.go:160` and `internal/hub/ws/helpers_test.go:39`.

## Server

`internal/node/repo/git.go:376-420` `history()` gains an `all bool` parameter.

- `all == false`: argv unchanged, byte for byte. `service_test.go:165-170` pins it.
- `all == true`: `log <historyFlags> -z --format=<logFormat> --max-count=101 --skip=<skip> --date-order --branches --tags --remotes --end-of-options HEAD`. Flags must come before `--end-of-options`. `--date-order` guarantees children before parents, which the lane layout needs. Unborn HEAD still answers an empty page.
- Revised 2026-10-14 after review: `--date-order` walks the whole history before the first row when there is no commit-graph file (6.1 s on 1M commits). The argv now omits it and uses Git's default order. The UI fixes the order of loaded commits with `graphOrder` in `graph-layout.ts`.
- `repo.go:217-228` passes `req.All` through.
- Tests: `service_test.go` argv table gets the `all` case. `log_test.go` fixture gains a branch `topic` with one commit not merged into `main`. The `all` page contains it, the HEAD page does not, the merge commit comes before both its parents, paging with `skip` continues the same order, and refs on `topic` read `topic`.

## UI

### Layout module

`ui/src/components/files/graph-layout.ts`, pure, tested in node. Input: the loaded commits in order (`{hash, parents}`), output one `GraphRow` per commit:

```ts
type GraphRow = { lane: number; color: number; lanes: number; edges: GraphEdge[] }
type GraphEdge = { from: number; to: number; color: number; kind: "pass" | "parent" | "merge" }
```

Rows draw only the segment from their own centre to the top of the next row. Active lanes hold the hash they expect next. For a commit: take the first lane expecting its hash, else append a lane. First parent inherits the lane. Other parents take an existing lane that expects them or a new lane. Lanes that expected the same hash collapse into it (`merge` edges). Lanes with no commit this row pass through (`pass`). Parents outside the loaded page keep their lane open to the bottom. Colors cycle over 6 values per lane stream. `lanes` is the active lane count for the row.

Tests: linear history, branch and merge, octopus merge, two roots, parents beyond the page, lane reuse after a merge, deterministic output for the same input, 1000 commits under 50 ms.

### Data

`useCommitLog` in `commit-log.tsx:31-180` gains `all?: boolean`. It goes into the request and the state key. The "same HEAD keeps older pages" rule (`:81-96`) stays. Paging through `loadMore` is unchanged.

### Tab

- `stores/main-tabs-store.ts`: `GraphTab { kind: "graph"; id; paneId; contextPath }`, `graphTabId(contextPath) = "graph:" + contextPath`, `openGraph({paneId, contextPath})` upsert like `openCommit` (`:200-212`), `isMainTab` branch (`:109-131`), group `all` only. Tests in `main-tabs-store.test.ts`.
- `components/terminal/main-tabs.tsx:58-98`: strip entry, label "Graph", detail is the folder name, icon `GitGraph` from lucide if the installed version has it, else `GitFork`.
- `components/terminal/terminal-workspace.tsx:44-46, 310-326`: lazy `GraphTabView` like `CommitTabView`.
- `components/files/graph-tab-view.tsx`: header bar like `commit-tab-view.tsx:39-63` with title "Graph", repository folder and branch, a Refresh `HeaderButton` and Close. Body states: disconnected notice, unsupported feature notice, not a repository, error with "Try again", loading, list.
- `components/files/graph-list.tsx`: the rows. Each row is a `<button data-tree-row>` for `useTreeKeyboard` roving (`sidebar/tree-row.tsx:59-81`), `aria-current` when its hash is the active commit tab. Columns: graph cell, ref chips (`RefChip` from `commit-log.tsx:198`), subject truncated with `title`, author, age with the full date in `title`, short hash in tabular numbers. Row height fixed (28 px desktop). Graph cell is an inline `<svg>` sized `lanes * 14` wide, with `stroke-chart-1..5` and `text-chart-*` classes. Node: filled circle, larger ring for the HEAD commit, hollow for merges. Lane changes draw a cubic curve from the centre to the next row top. Cap visible lanes at 24 and show a muted "+N" when more.
- Revised 2026-10-14 after review round 2: only the graph in front holds its `repo:watch` and counts pushes. The server allows 4 watches per connection, and hidden graphs took slots from the focused repository. A hidden graph reloads its first page once when it is shown again. A refused watch goes out again when another root frees a slot. Rows keep their element while commit and layout compare equal by value, so a new first page renders only changed rows.
- `[content-visibility:auto]` with `containIntrinsicSize` on rows, same as `CommitRow`. "Load older commits" button at the end, same copy as the History view.
- Opening points: History sidebar header (`components/sidebar/history-view.tsx`) gets a `PanelIconButton` "Open graph" shown only when `features.has("repo:graph")`. Command palette (`components/command/command-palette.tsx:79-105`) gets "Open git graph" when a repository context exists.

### Rules

Native buttons, visible focus, names on icon buttons, no color alone for meaning (merge and HEAD have shapes and `title`), semantic tokens only, sentence case, verb first on buttons.

## Tests

Go: `go vet ./...`, `go test ./...`. TS: layout tests, store tests, protocol fixture tests, `pnpm typecheck`, `pnpm --filter @app/ui build`.

## Browser check

Build a repository in the dev container scratch dir with two branches, a merge, a tag and an unmerged branch. Open the graph from the History sidebar, confirm lanes and refs, click a row, confirm the commit tab opens, use arrow keys, load more on a repository with more than 100 commits (`/repo` works for that, read only).

## Out of scope

Branch picker, search, checkout or any write, phone layout, file history.
