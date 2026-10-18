# Protocol Reference

Every message between the browser and the tmuxde server, as defined in
`src/ui/src/protocol`, imported as `@/protocol`.

`client-messages.ts` and `server-messages.ts` hold Zod discriminated unions,
one JSON object per WebSocket message on `/_relay`. `codec.ts` validates both
directions. **59** client types and **32** server types, the `repo:*` types
from `repository.ts` included. The Go server has a hand written
type for each one in `internal/protocol/client` and `internal/protocol/server`.
`fixtures/` holds a sample of every type plus invalid cases, and both the
Vitest fixture test (`fixtures.test.ts`) and the Go contract test
(`internal/protocol/contract_test.go`) check them.

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
| `pane:swap` | `id`, `direction?: "U"\|"D"\|"L"\|"R"`, `target?` | Swap a pane with its neighbour toward `direction`, or with pane `target`. Exactly one of the two |
| `pane:join` | `id`, `windowId`, `direction: "h" \| "v"` | Move a pane into window `windowId`, beside its active pane for `h` or below it for `v` |
| `pane:break` | `id` | Move a pane out into a new window |
| `pane:kill` | `id` | Kill a pane |
| `pane:capture` | `id` | Capture a pane's contents as text |

Every pane and window id in these messages must belong to the attached session.
The server answers `PANE_NOT_FOUND` or `WINDOW_NOT_FOUND` for the first one that
does not, and runs nothing. A swap with `target` runs `swap-pane -s id -t target`.
The panes may sit in different windows, and each window activates the pane it
received. A join makes the moved pane active and shows its window. A window left
without panes closes. A join into the pane's own window fails with the tmux
error while the pane is the active pane there, since tmux splits that pane. A
break opens the new window at the first free index of the attached session and
shows it. On the only pane of a window, tmux moves that window to a new index.
None of the three has a reply of its own. `window:changed` and `pane:changed`
follow, as for every layout change.

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
| `file:upload` | `path`, `content` (base64), `final`, `ack?` | Chunked upload (max 1 GiB with `file:upload:1gib` in machine features, otherwise 10 MiB). With `ack: true`, each chunk returns `file:op:result` with `final` echoed after write completes. Wait for acknowledgement before sending next chunk. Requires `file:upload:ack` in `auth:success.features`. General file transfers use a dedicated machine-bound socket. Closing it discards partial files; final acknowledgement confirms atomic replacement. Transfers do not resume after disconnect. |
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
  all?: boolean; // log: every branch, tag and remote branch, not only HEAD.
  commit?: string; // show: 7 to 64 lowercase hex characters.
}
```

`context` resolves current pane directory from tmux. `list` defaults to that
directory. `read` requires `path`. `status` and `diff` accept captured context
in `path` so changing pane directory does not silently switch repositories.
`diff` requires `file`, relative to repository root, and `scope`.

`log` and `show` require `repo:history` in `auth:success.features`. `log`
pages history from `HEAD`, 100 commits per page, starting after `skip`
commits. With `all: true`, which requires `repo:graph` in
`auth:success.features`, `log` walks every local branch, tag and remote
branch as well as `HEAD`. Both walks use Git's default order, newest commit
date first, so the first page streams without a walk of the whole history.
When commit dates disagree a parent can come before one of its children, so
a client that draws lanes orders the loaded commits itself. Pages continue
the same order. Other actions ignore `all`. `show`
requires `commit` and answers its metadata and whole patch. A merge is compared with its first parent. A root commit is compared with an
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

### Repository watch

Requires `repo:watch` in `auth:success.features`. The server pushes
`repo:changed` while the repository of a pane changes, so the client does not
have to poll.

| Type | Fields | Description |
| --- | --- | --- |
| `repo:watch` | `id`, `path?` | Watch the repository of pane `id`. Answered by `repo:watch:result` |
| `repo:unwatch` | `root` | Stop the watch of `root`, as `repo:watch:result` named it. No reply |

`id` follows the ownership rule of `repo:request`: the pane must belong to the
attached session, and its folder comes from tmux. `path` is the captured
context folder, absolute, checked against allowed paths. An empty or relative
`path` is refused. A second watch of a watched root answers `ok` again and
changes nothing. A connection holds at most 4 repository watches. All end when
the connection closes, so a client sends `repo:watch` again after it
reconnects.

The server watches the Git directory, and the common directory of a linked
work tree, for `HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`,
`REBASE_HEAD`, `REVERT_HEAD`, `index`, `packed-refs` and everything under
`refs`. Lock files are ignored. It watches the work tree one directory at a
time, at most 4,096 directories and 5 seconds of walking. It never follows
symlinks, skips `.git` entries, paths the file policy denies and directories
Git ignores, and drops editor temp files. Events are coalesced: a batch goes
out 250 ms after the last event, and at most 1 second after the first.

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

### Repository watch events

| Type | Fields | Description |
| --- | --- | --- |
| `repo:watch:result` | `root: string \| null`, `ok`, `partial`, `message?` | Answer to `repo:watch`. Sent again when the watch turns partial |
| `repo:changed` | `root`, `git`, `refs`, `paths: string[]`, `truncated` | Something changed in a watched repository |

`ok` false means no events come. `message` says why: not attached, pane not
found, not a repository, access denied, too many repository watchers, or a
watch that failed to start. Refusals never come as `error`, so a client falls
back to polling without a toast. `root` is null when no repository was found.
`partial` is true when the directory or time cap stopped the first walk, so
part of the work tree is not watched and the client keeps its regular poll.
Folders made later, and folders a changed ignore rule uncovers, are walked
too. When such a walk hits a cap, the server sends `repo:watch:result` for
the watched root once more, with `ok` and `partial` true.

`paths` are work tree paths relative to `root` with forward slashes, deduped
and sorted, at most 64. Ignored paths never appear, and a batch of only
ignored paths sends nothing. `truncated` is true when more paths changed,
events were lost or a `.gitignore` or `info/exclude` changed, and the client
should treat everything as changed. `git` is true when HEAD, the index or
refs changed. `refs` is true when `HEAD`, `packed-refs` or anything under
`refs` changed, so history and the commit graph may differ. An index only
change, such as `git add` or the index refresh of `git status`, sets `git`
without `refs`. Lost events set both. Git directory paths never appear in
`paths`.

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

Server (`internal/hub/dictation`) to the optional `stt` service, the Go
binary `tmuxde-stt` in `internal/stt`, over unix socket `stt/stt.sock` in the
run directory. The service has no TCP listener. Browsers never reach it. One
WebSocket per dictation on `/v1/stream`, plus `GET /health` answering
`{ ok, model, sessions }`.

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

1. Add the Zod schema to the right file in `src/ui/src/protocol/`.
2. Add it to the discriminated union. A rule across fields of one client
   message goes in the refinement on `ClientMessage`, and its Go `Validate`
   reports the same field.
3. Add the Go type and its registry entry in `internal/protocol/client` or
   `internal/protocol/server`.
4. Add a fixture in `src/ui/src/protocol/fixtures`, plus invalid cases. The
   samples together set every field, and each optional field is left out by
   one of them.
5. Handle client messages in `internal/node/local/router.go`.
6. Handle server messages in `src/ui/src/hooks/use-websocket.ts`.

## Machine routing

Browser WebSocket `/_relay?machine=<id>` binds to one machine after token
validation. Omitted machine selects `local`. Unknown or offline machine returns
`error` with code `MACHINE_OFFLINE` and closes with 1013. It never falls back to
local machine. Node messages and their existing schemas remain unchanged.
`server:info` and node features describe selected machine, except `uptime`, which
is the hub process uptime for every machine. Dictation remains hub
service. Login uses reserved `machine=hub` connection, which authenticates without
opening node. Node requests on that connection return `MACHINE_REQUIRED`.

`GET /machines` requires browser bearer token and returns array validated by
`machines.ts`: id, name, online, hostname, platform, defaultPath, version and
features. Offline entries retain ID and display name. No credentials appear in
response. Response uses `Cache-Control: no-store`. UI polls inventory independently
of selected machine socket, including while agent is offline.

`GET /file?machine=<id>&path=<path>` uses same explicit machine selection and
browser authentication. Missing machine means local. Offline machine returns 503.
Path validation and open happen on selected machine. Range reads use same opened
file through bounded agent chunks.

## Agent protocol version 1

Agents connect outbound to `/_agent` with `Authorization: Bearer <agent-token>`.
Browser tokens and browser Origin headers are rejected. Initial text frame is
`{"protocol":1,"info":{...}}`. Info carries hostname, platform, defaultPath,
version and features. Hub assigns ID/name from credential registry and responds
with same hello shape. Protocol mismatch closes connection. Only WebSocket
ping/pong follows from agent on control link. Hub probes liveness and revocation.

Hub requests dedicated outbound stream with
`{"ticket":"<64 hex characters>","kind":"node"}` or kind `file`. Agent connects
`/_agent/stream` with bearer token and `X-Tmuxde-Ticket` header. Ticket belongs to
one machine control connection and can be consumed once. New control connection
has fresh pending tickets. Credentials never appear in query strings.

Node stream carries existing client/server JSON messages, one per frame, with
sequential request handling. Auth, ping and dictation are hub-owned and excluded.
Closing stream releases its local node context without killing tmux sessions.
Every browser gets separate context and attach client.

File stream starts with `{"path":"/absolute/path"}`. Agent opens through path
guard and replies with name, size and modified timestamp, or error `denied`,
`not-file` or `not-found`. Hub requests `{"offset":0,"length":65536}` and receives
one binary frame of up to 65536 bytes. Empty binary frame means EOF. Stream close
releases file. Files are never buffered in full by central server.

Control hello limit is 16 KiB. Data frame limit is 2 MiB. Each machine has 64
pending/active streams. Write and stream establishment timeouts are 15 seconds.
Agent reconnects with bounded backoff and jitter. Input and mutations are never
replayed. Link failure closes all data streams and browser attachment sockets;
UI reconnects with fresh session inventory and attachment.

### Global terminal history search

Feature `terminal:search` enables machine-wide, read-only history search without
attaching a session. Browser fans requests out over authenticated inventory
connections and keeps machine IDs separate when pane IDs overlap.

Client `terminal:search` fields: `requestId` (1 to 128 characters), `query`
(nonblank, single-line literal text, 1 to 256 characters, no NUL),
`caseSensitive` (boolean), and `excludeSessions` (array of session names, at most
1024). Query is literal, including regex punctuation. Case-insensitive matching
uses Unicode simple case folding.

Server `terminal:search:result` echoes `requestId` and includes `matches`,
`searchedPanes`, `skippedPanes`, `partial`, and optional `error`. Each match has
`sessionName`, `windowId`, `paneId`, `command`, `path`, `line`, `text`, `before`
and `after`. `line` is one-based within captured logical lines. Soft wraps are
joined. Excerpts are plain text. Results use session listing order and newest
matching lines first within each pane. Linked panes are searched once.

Search reads full history retained by tmux plus visible screen. Closed panes,
hidden sessions and excluded sessions are omitted. Panes linked from an excluded
session are excluded everywhere. Current output is a snapshot, not a durable
archive. No history is written or persisted. Query text and excerpts are redacted
from message logs. Browser clears results and pending requests on lock or sign-out.

One search runs per node, with a 10-second deadline, up to 256 panes, 100 matching
lines, and a 64 MiB capture budget checked before each pane. Each capture uses the
tmux client's output cap (16 MiB by default), so budget may exceed 64 MiB by one
capture. `partial` reports capture, result, pane or time limits and failed pane
reads. Partial results must never be presented as a complete no-match result.
Offline and older machines are reported separately by UI. Busy or failed requests
return `error` with matching `requestId`. Searches are never queued for reconnect.

Results open their source through existing machine/session/pane navigation.
Opening a result selects its pane at current terminal position. Snippets preserve
matched text even if output has since moved. No historical scroll offset is implied.

### Live terminal previews

Feature `terminal:preview` enables read-only visible-screen previews on inventory connections.

- Client `terminal:preview`: `requestId` (1 to 128 characters), `targets` (up to 32 `{session, paneId}` pairs), `excludeSessions` (up to 1024 session names), `once` (boolean). Session names are 1 to 256 characters and pane IDs match `%` followed by digits. Replaces the connection's previous subscription. Empty targets stop it. `once: true` returns one snapshot. UI previews use continuous subscriptions with `once: false`.
- Server `terminal:preview:frame`: matching `requestId`, `frames` (up to 32 `{paneId, cols, rows, content, unavailable}` records). Content contains ANSI SGR visible-screen output, no history. Dimensions use terminal limits (1 to 1000 columns, 1 to 500 rows). An unavailable pane has empty content. Only changed frames are sent.
- Captures repeat after 150 ms. Each pass has a two-second timeout, a 128 KiB per-screen cap and a 1 MiB aggregate budget. Subscriptions expire after 35 seconds; visible live clients renew every 20 seconds. Disconnect, replacement or empty targets cancels capture and waits for the previous sender to stop.
- Every pass verifies session membership and rejects hidden sessions, excluded sessions and their linked panes. Reads never attach a PTY, select a pane, resize tmux or send input. Preview content is omitted from logs.
- UI continuously watches visible cards and open hover previews, including when reduced motion is enabled. Hidden documents and closed Overview tabs stop their subscriptions. Device lock and sign-out discard frames. Frames are memory-only and separate from copy captures. Sidebar hover previews share screen subscriptions with Overview. Each hover owner stops on close, keeps subscriptions alive independently of Overview, and receives live updates while open.

### Workspace filename search

`repo:search` in machine features enables `repo:request` action `search`.
`query` is an optional string of 1 to 256 characters on the wire, required and
nonblank for search. `path` selects workspace root, otherwise pane folder is
used. Attached-session pane ownership, file capabilities and allowed/denied
path guards apply exactly as for other repository reads. Existing machine
forwarding and correlated `repo:result` handling carry this action unchanged.

Result is `{ kind: "search", path: string, files: string[], truncated: boolean }`.
`path` is canonical searched directory. `files` contains at most 100 relative
regular-file paths, each at most 4096 characters. Results prefer exact basename,
prefix, substring, path and then ordered-character matches. Space-separated
query terms are case-insensitive and all must match. File contents are not read.

Search skips `.git`, `node_modules`, `.cache`, `.venv` and `__pycache__`
directories. Directory symlinks are never traversed. File symlinks must resolve
inside searched root and pass path guards. Hidden and Git-ignored files remain
searchable unless policy denies them. Root-confined filesystem access prevents
symlink swaps from escaping workspace.

One search runs per machine repository service. Scans stop at 100,000 entries,
64 levels or three seconds; returned path text is capped at 128 KiB. Extra
matches, scan limits or unreadable subdirectories set `truncated`. Callers must
show partial results and offer a narrower query. Concurrent requests receive
correlated error with retry guidance. Disconnect cancels work. Search requests
are not replayed after reconnect. Browser discards stale query/context replies.
