# Protocol Reference

Every message between the browser and the tmuxde server, as defined in
`@repo/protocol`.

`client-messages.ts` and `server-messages.ts` hold Zod discriminated unions,
one JSON object per WebSocket message on `/_relay`. `codec.ts` validates both
directions. **55** client types and **30** server types, `repo:request` and
`repo:result` from `repository.ts` included. The Go server has a hand written
type for each one in `internal/protocol/client` and `internal/protocol/server`.
`fixtures/` holds a sample of every type plus invalid cases, and both the
Vitest fixture test and the Go contract test check them.

---

## Client → server

### Authentication and keep-alive

| Type | Fields | Description |
| --- | --- | --- |
| `auth` | `token: string` | Must be the first message, within 5 seconds |
| `ping` | `timestamp: number` | Latency measurement |

### Sessions

| Type | Fields | Description |
| --- | --- | --- |
| `session:list` | None | List all tmux sessions |
| `session:create` | `name?`, `cwd?`, `command?` | Create a session |
| `session:attach` | `name`, `size?`, `capture?`, `attachId?` | Attach to a session |
| `session:detach` | None | Detach from the current session |
| `session:kill` | `name` | Kill a session |
| `session:rename` | `oldName`, `newName` | Rename a session |
| `session:windows` | `name` | Windows and panes for a session |

`attachId` is an attach epoch, echoed back on `session:attached` so a client can
reject the acknowledgement of a superseded attach instead of letting a stale one
corrupt its state machine. Optional, so older clients stay compatible.

### Terminal I/O

| Type | Fields | Description |
| --- | --- | --- |
| `terminal:input` | `data: string` | Keystrokes to the PTY |
| `terminal:resize` | `size: { cols, rows }` | Resize the terminal |

`cols` is 1 to 1000, `rows` 1 to 500.

### Panes

| Type | Fields | Description |
| --- | --- | --- |
| `pane:list` | None | Panes in the active window |
| `pane:split` | `direction: "h" \| "v"` | Split the active pane. New pane starts in its folder |
| `pane:select` | `id` | Focus a pane and show its window |
| `pane:step` | `delta: integer` | Focus the next pane of the current window, or the previous one when `delta` is negative |
| `pane:zoom` | `id?`, `zoomed?` | Zoom a pane, the active one without `id`. Without `zoomed` it toggles |
| `pane:resize` | `id`, `direction: "U"\|"D"\|"L"\|"R"`, `amount` | Resize a pane |
| `pane:swap` | `id`, `direction` | Swap a pane with its neighbour |
| `pane:kill` | `id` | Kill a pane |
| `pane:capture` | `id` | Capture a pane's contents as text |

### Windows

| Type | Fields | Description |
| --- | --- | --- |
| `window:list` | None | Windows in the active session |
| `window:create` | `name?` | Create a window |
| `window:select` | `id` | Focus a window |
| `window:step` | `delta: integer` | Next window, or the previous one when `delta` is negative. Wraps |
| `window:rename` | `id`, `name` | Rename a window |
| `window:kill` | `id` | Kill a window |
| `window:layout` | `preset` | Apply a tmux layout |
| `layout:rotate` | None | Rotate the current layout |

`preset` is one of `even-horizontal`, `even-vertical`, `main-horizontal`,
`main-vertical`, `tiled`.

### tmux control

| Type | Fields | Description |
| --- | --- | --- |
| `tmux:prefix` | None | Send the tmux prefix key |
| `tmux:copy-mode` | None | Enter copy mode |
| `tmux:scroll` | `lines: number` | Scroll active pane up for positive values, down for negative values. Range: -500 to 500 |
| `tmux:scroll-to` | `position: number` | Jump to position in tmux history, measured in lines above live output |
| `tmux:scroll-state` | No fields | Request current history position and copy-mode state |
| `tmux:exit-copy-mode` | No fields | Leave copy mode |

Relative scrolling sends mouse wheel events to apps with mouse reporting enabled.
Alternate-screen apps without mouse support receive arrow keys. Normal shell
output uses tmux history. Explicit copy mode keeps history scrolling until exited.
Mouse events target center of active pane. Scrollbar history size is zero while
app handles scrolling, so shell history rail stays hidden during TUI use.

### Commands

| Type | Fields | Description |
| --- | --- | --- |
| `command:send` | `command: string` | Send a command, appending Enter |
| `command:interrupt` | None | Ctrl+C |
| `command:eof` | None | Ctrl+D |
| `command:clear` | None | Clear the screen |
| `command:suspend` | None | Ctrl+Z |

### Files

| Type | Fields | Description |
| --- | --- | --- |
| `file:list` | `path` | List a directory |
| `file:read` | `path` | Read a file (truncated above 100 KB) |
| `file:stat` | `path` | File metadata |
| `file:write` | `path`, `content` | Overwrite a file (max 1 MB) |
| `file:create` | `path`, `content?` | Create a file |
| `file:mkdir` | `path` | Create a directory |
| `file:delete` | `path` | Delete a file or directory |
| `file:rename` | `oldPath`, `newPath` | Rename or move |
| `file:upload` | `path`, `content` (base64), `final`, `ack?` | Chunked upload (max 10 MB). With `ack: true`, each chunk returns `file:op:result` with `final` echoed after write completes. Wait for acknowledgement before sending next chunk. Requires `file:upload:ack` in `auth:success.features`. |
| `file:watch` | `path` | Watch a directory (`depth: 0`) |
| `file:unwatch` | `path` | Stop watching |

Every one of these passes the `ALLOWED_PATHS` guard before touching the disk.

### Repository viewer

Requires `repo:request` in `auth:success.features`, file read access, and a pane
inside attached session. Each request receives `repo:result` with matching
`requestId`, including permission denials and errors.

```ts
{
  type: "repo:request";
  requestId: string;
  id: string; // Target pane ID. Required for every action.
  action: "context" | "list" | "read" | "status" | "diff" | "log" | "show";
  path?: string;
  file?: string;
  scope?: "unstaged" | "staged" | "untracked";
  skip?: number; // log: commits to pass over. Integer, 0 to 1,000,000.
  commit?: string; // show: 7 to 64 lowercase hex characters.
}
```

`context` resolves current pane directory from tmux. `list` defaults to that
directory. `read` requires `path`. `status` and `diff` accept captured context
in `path` so changing pane directory does not silently switch repositories.
`diff` requires `file`, relative to repository root, and `scope`.

`log` and `show` require `repo:history` in `auth:success.features`. `log`
pages history from `HEAD`, 100 commits per page, starting after `skip`
commits. `show` requires `commit` and answers its metadata and whole patch.
A merge is compared with its first parent. A root commit is compared with an
empty tree. Files whose path file policy denies are left out and counted in
`hidden`. History reads also disable signature verification, mailmap and
notes, so a repository setting never runs a GPG program.

All paths pass server file policy. Git roots, worktree metadata, and common Git
directories must remain inside allowed paths. Git configuration includes,
configured filters, object alternates, and metadata symlinks are refused. Git
reads disable hooks, external diffs, text conversion, filesystem monitors,
optional index writes, and network protocols. Each Git command has a 5 second
timeout and a 512 KiB output limit. Text reads stop at 100 KiB. Directory and
status results stop at 2,000 entries and report truncation. Binary content is
flagged. Repository actions never stage, commit, restore, or write files.

### Dictation

Requires `dictation` in `auth:success.features`, which the server sends only
while the optional speech service answers its health check. Starting and
feeding audio need write access. Stop and cancel only end what this
connection started.

| Type | Fields | Description |
| --- | --- | --- |
| `dictation:start` | `id` | Open a speech session. A second start cancels the first |
| `dictation:audio` | `id`, `pcm` | Audio frame: 16 kHz mono PCM16 little endian, base64, at most 64 KiB |
| `dictation:stop` | `id` | Done talking. The rest is transcribed, then `dictation:done` |
| `dictation:cancel` | `id` | Drop the session. Text not yet sent is discarded |

`id` is 1 to 64 characters, chosen by the client, so a late reply for a
cancelled dictation can be ignored. Frames of 100 to 250 ms work well. The
client holds audio until `dictation:ready`. The server queues at most 1 MiB
toward the speech service before answering `OVERLOADED`, and ends any
session after 15 minutes. The service stops taking audio at 10 minutes.
None of these messages are queued across a reconnect.

## Server → client

### Authentication, keep-alive, errors

| Type | Fields | Description |
| --- | --- | --- |
| `auth:success` | `serverVersion` | Authenticated |
| `auth:failure` | `reason` | Rejected; the socket then closes |
| `pong` | `timestamp` | Reply to `ping` |
| `error` | `code`, `message` | Error response, e.g. `RATE_LIMITED` |
| `server:info` | `hostname`, `platform`, `uptime` | Sent right after `auth:success` |

### Sessions

| Type | Fields | Description |
| --- | --- | --- |
| `session:list` | `sessions: SessionInfo[]` | Full session list. Answers `session:list`, follows a rename, and the Go server also pushes it unasked when its session poll sees a name, id, window count or attached flag change. Clients match sessions by `id`, so a rename arrives as the same id under a new name |
| `session:created` | `session: SessionInfo` | A session was created |
| `session:killed` | `name` | A session was killed |
| `session:activity` | `name`, `activity` | Activity timestamp updated |
| `session:exited` | `name`, `exitCode?` | The session's process exited, or the attached tmux client ended. The web drops the active session on it |
| `session:attached` | `name`, `attachId?` | Attach acknowledged |
| `session:windows` | `name`, `windows[]`, `panes[]` | Response to `session:windows` |

### Terminal

| Type | Fields | Description |
| --- | --- | --- |
| `terminal:output` | `data: string` | PTY output |
| `tmux:scroll-state` | `position`, `historySize`, `paneHeight`, `inMode` | History position and copy-mode state after scrolling or polling |

### Panes and windows

| Type | Fields | Description |
| --- | --- | --- |
| `pane:list` | `panes: PaneInfo[]`, `windowId` | Response to `pane:list` |
| `pane:changed` | `panes: PaneInfo[]`, `windowId` | Pane layout changed |
| `pane:captured` | `id`, `content` | Response to `pane:capture` |
| `window:list` | `windows: WindowInfo[]`, `sessionName` | Response to `window:list` |
| `window:changed` | `windows: WindowInfo[]`, `sessionName` | Window set changed |

### Files

| Type | Fields | Description |
| --- | --- | --- |
| `file:list` | `path`, `entries: FileEntry[]` | Directory listing |
| `file:content` | `path`, `content`, `truncated` | File contents |
| `file:stat` | `stat: FileStat` | File metadata |
| `file:changed` | `path`, `event` | Filesystem change event |
| `file:write:result` | `path`, `success`, `error?`, `size?` | Result of `file:write` |
| `file:op:result` | `op`, `path`, `success`, `error?` | Result of create/mkdir/delete/rename/upload |

### Repository results

`repo:result` contains `requestId` and `result`. `result.kind` selects one shape:

| Kind | Fields |
| --- | --- |
| `context` | `path`, `root: string \| null`, `branch: string \| null` |
| `list` | `path`, `entries: FileEntry[]`, `truncated` |
| `read` | `path`, `content`, `truncated`, `binary` |
| `status` | `root`, `branch`, `entries: { path, originalPath?, index, worktree }[]`, `truncated` |
| `diff` | `path`, `scope`, `content`, `truncated`, `binary` |
| `log` | `root: string \| null`, `branch: string \| null`, `skip`, `commits: Commit[]`, `more` |
| `show` | `root`, `commit: Commit & { email, committer, committerDate, body }`, `files: CommitFile[]`, `hidden`, `truncated` |
| `error` | `message` |

`Commit` is `{ hash, parents: string[], author, date, subject, refs: string[] }`.
`date` is the author date in ISO 8601. `refs` are decorations as Git prints
them, such as `HEAD -> main` or `tag: v1`. `more` is true when older commits
exist past the page.

`CommitFile` is `{ path, originalPath?, status, additions, deletions, binary,
patch }`. `status` is the Git raw status letter (`A`, `M`, `D`, `R`, `C`,
`T`). `originalPath` is set for renames and copies. Counts are null for binary
files. `patch` is this file's section of the patch from its `diff --git` line,
and is empty when output reached the size limit before it. `truncated` marks a
patch cut at the output limit or a commit with more than 2,000 files.

Status paths are relative to repository root. `index` and `worktree` preserve
Git porcelain status characters, including spaces and `?` for untracked files.
Renames include `originalPath`. Outside Git repositories, context and status
return null root and branch. Detached HEAD returns null branch. Staged diffs
also work before first commit.

### Dictation

| Type | Fields | Description |
| --- | --- | --- |
| `dictation:ready` | `id` | Speech service is listening |
| `dictation:text` | `id`, `text` | Transcribed text for one utterance, in order |
| `dictation:done` | `id` | Everything after stop is transcribed. Last message |
| `dictation:error` | `id`, `code`, `message` | Session ended without finishing. Last message |

Text arrives while the user is still talking: the service decodes each
utterance once the speaker pauses. Pieces carry no separator, the client
decides spacing. `code` is `UNAVAILABLE`, `BUSY`, `OVERLOADED`, `NOT_FOUND`
or `FAILED`. `message` is safe to show.


## Shared schemas

```typescript
type TerminalSize = { cols: number; rows: number };  // cols 1 to 1000, rows 1 to 500

type SessionInfo = {
  name: string;
  id: string;
  windows: number;
  attached: boolean;
  created: string;    // ISO timestamp
  activity: string;   // ISO timestamp
  dimensions?: TerminalSize;
};

type PaneInfo = {
  id: string;
  index: number;
  windowId: string;
  active: boolean;
  zoomed: boolean;
  dimensions: TerminalSize;
  position: { x: number; y: number };
  command?: string;
  path?: string;
};

type WindowInfo = {
  id: string;
  index: number;
  name: string;
  active: boolean;
  paneCount: number;
  layout: string;
  dimensions?: TerminalSize;
};

type FileEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modified: string;   // ISO timestamp
};

type FileStat = FileEntry & {
  created: string;
  permissions: string;
  isReadable: boolean;
  isWritable: boolean;
};
```

---

## Speech service (internal)

Server to optional `stt` service, over unix socket `stt/stt.sock` in the run
directory. The service has no TCP listener. Browsers never reach it. One WebSocket per dictation on `/v1/stream`, plus
`GET /health` answering `{ ok, model, sessions }`.

Server sends binary frames of 16 kHz mono PCM16 little endian, and one text
frame `{"type":"stop"}`. Service sends JSON text frames:

| Type | Fields | Description |
| --- | --- | --- |
| `ready` | | Session open |
| `text` | `text` | One decoded utterance |
| `done` | | All audio decoded. Socket closes with 1000 |
| `error` | `code`, `message` | `BAD_AUDIO`, `BAD_MESSAGE`, `DECODE_FAILED` or `IDLE`. Socket closes with 1011 |

A service at its session limit closes with 1013, which the server reports as
`BUSY`. The server validates every service message before anything reaches a
browser.

## Adding a message

1. Add the Zod schema to the right file in `packages/protocol/src/`.
2. Add it to the discriminated union.
3. Add the Go type and its registry entry in `internal/protocol/client` or
   `internal/protocol/server`.
4. Add a fixture in `packages/protocol/fixtures`, plus invalid cases.
5. Handle client messages in `internal/node/local/router.go`.
6. Handle server messages in `ui/src/hooks/use-websocket.ts`.
