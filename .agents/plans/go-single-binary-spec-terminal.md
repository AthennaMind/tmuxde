# Porting spec: relay terminal side

Source of truth for phase 4 of [go-single-binary.md](go-single-binary.md). Extracted 2026-10-12 from the relay sources by a read-only scout. Short names: TM `tmux-manager.ts`, SM `session-monitor.ts`, TC `tmux-clone.ts`, MR `message-router.ts`, POL `policy.ts`, WC `wire-connections.ts`, PB `pty-bridge.ts`, CM `connection-manager.ts`, all under `apps/relay/src/`. Line numbers at extraction time.

## Port notes (differences the Go port should make on purpose)

- `attachId`: the relay only echoes the string. Web generates `a1`, `a2`, ... (`apps/web/src/lib/attach-state.ts:35-38`), discards acks whose id does not match the attach in flight, and drops output until the ack arrives. The relay's `onReady` has no `conn.pty === bridge` guard (MR:355-364), so a superseded PTY can still send a stale `session:attached`. Go: guard ready, exit, spawn error and data on the current bridge.
- `pane:zoom` has no pane ownership check in policy (POL:97). Go: apply the ownership rule when `id` is set.
- `session:activity` is defined but never sent. Go: do not send it either. Keep the type.
- Clone creation is dropped. Keep the `__tmuxde_` name filter and the startup sweep.
- `swap-pane` with `L` or `R` fails on tmux 3.7c (only `-dDUZ`). Keep passing through, the error surfaces as `HANDLER_ERROR`.
- `sendKeys` (TM:165) is exported but unused. Do not port.

## 1. tmux commands

Common prefix: `tmux` plus `-S $TMUX_SOCKET` when set (TM:57-59, PB:44). Never `-f`. `execFile`, no shell. Default shell `TMUX_DEFAULT_SHELL`, default `/bin/bash`. Startup runs `tmux -V` without socket and exits on failure (index.ts:16).

Sessions:

| Function | argv |
| --- | --- |
| `listSessions` TM:63-68 | `list-sessions -F "#{session_name}\t#{session_id}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{window_width}\t#{window_height}"` |
| `createSession` TM:105-120 | `new-session -d -P -F "#{session_name}\t#{session_id}" [-s name] [-c cwd] <command or defaultShell>` |
| `killSession` TM:138 | `kill-session -t <name>` |
| `renameSession` TM:146 | `rename-session -t <old> <new>` |
| `sessionExists` TM:158 | `has-session -t <name>`, any error means false |
| PTY attach PB:43-49 | `attach-session -t <target>` on a pty, TERM `xterm-256color`, default 80x24, cwd `$HOME` or `/` |

Windows:

| Function | argv |
| --- | --- |
| `listWindows` TM:208-215 | `list-windows -t <s> -F "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{window_layout}\t#{window_width}\t#{window_height}\t#{window_activity_flag}\t#{window_zoomed_flag}"` |
| `currentWindowId` TM:268-276 | `display-message -p -t <s> "#{window_id}"`, trimmed |
| `stepWindow` TM:284-289 | `next-window -t <s>` when delta >= 0, else `previous-window -t <s>` |
| `createWindow` TM:572-574 | `new-window -t <s> [-n name] <defaultShell>` |
| `selectWindow` TM:580 | `select-window -t <windowId>` (bare id) |
| `killWindow` TM:585 | `kill-window -t <windowId>` |
| `renameWindow` TM:607 | `rename-window -t <windowId> <name>` |
| `selectLayout` TM:621 | `select-layout -t <s> <preset>` (even-horizontal, even-vertical, main-horizontal, main-vertical, tiled) |
| `rotateLayout` TM:632 | `rotate-window -t <s>` |

Panes:

| Function | argv |
| --- | --- |
| `-Z` probe TM:299-312 | `list-commands select-pane`, supported if stdout matches `/-[A-Za-z]*Z/`. Error means false. Cached per process |
| `stepPane` TM:326-331 | `select-pane [-Z] -t "<s>:.+"` or `"<s>:.-"` |
| `listPanes` TM:340-350 | With window id: `list-panes -t "<s>:<windowId>" -F F`. Without: `list-panes -s -t <s> -F F`. F = `"#{pane_id}\t#{pane_index}\t#{window_id}\t#{pane_active}\t#{window_zoomed_flag}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}\t#{pane_current_command}\t#{pane_current_path}"` |
| `splitPane` TM:427-435 | `split-window -t <s> -h|-v -c "#{pane_current_path}"` |
| `selectPane` TM:448-474 | With session: `display-message -p -t <pane> "#{window_id}"`, then `select-window -t "<s>:<wid>"`. Always: `select-pane [-Z] -t <pane>` |
| `zoomPane` TM:501-545 | see section 5 |
| `resizePane` TM:552 | `resize-pane -t <pane> -U|-D|-L|-R <amount>` |
| `killPane` TM:564 | `kill-pane -t <pane>` |
| `swapPane` TM:593 | `swap-pane -t <pane> -<dir>` |

Scroll and copy mode:

- State read TM:663-681: `display-message -p -t <s> "#{pane_id}\t#{pane_in_mode}\t#{scroll_position}\t#{history_size}\t#{pane_height}\t#{pane_width}\t#{alternate_on}\t#{mouse_any_flag}\t#{mouse_sgr_flag}\t#{mouse_utf8_flag}"`
- `enterCopyMode` TM:642: `copy-mode -t <s>`
- `scrollHistory` TM:761-797: mouse wheel `send-keys -t <pane> -N <repeat> -H <hex...>`; arrow keys `send-keys -t <pane> -N <repeat> Up|Down`; copy mode `copy-mode -e -t <pane>` then `send-keys -t <pane> -X -N <|count|> scroll-up|scroll-down`
- `exitCopyMode` TM:828-837: read state, then `send-keys -t <s> -X cancel` only if in a mode

Capture (`captureArgs` TM:40-55): `capture-pane -t <target> -p [-e] -S -<lines>`. No `-J`, no `-E`. `capturePane(session)` default 2000 lines, escapes on. `capturePaneById(id)` default 2000 lines, escapes off. Router always uses defaults (MR:239, MR:1018).

Prefix: `send-prefix -t <s>` (TM:637).

Command messages:

| Message | Action | Nothing attached |
| --- | --- | --- |
| `command:send` MR:475-482 | PTY write `command + "\r"` | `NOT_ATTACHED` |
| `command:interrupt` MR:484-489 | `send-keys -t <attachedSession> C-c` (TM:176-184) | silent no-op |
| `command:eof` | PTY write `"\x04"` | silent no-op |
| `command:clear` | PTY write `"\x1b[2J\x1b[H"` as input | silent no-op |
| `command:suspend` | PTY write `"\x1a"` | silent no-op |
| `terminal:input` MR:446-453 | PTY write raw data | `NOT_ATTACHED` |

## 2. Parsing

All list parsers: `stdout.trim().split("\n").filter(Boolean)`, split on `\t`, `parseInt(..., 10)`.

SessionInfo (TM:74-88): `name`, `id` strings. `windows` int. `attached` is `=== "1"`. `created`, `activity` epoch seconds times 1000 to ISO string. `dimensions` `{cols: window_width, rows: window_height}` only if both non empty. `createSession` returns synthetic `windows: 1`, `attached: false`, `created` and `activity` now, no dimensions (TM:127-134).

WindowInfo (TM:234-251): `id`, `index`, `name`, `active`, `paneCount`, `layout` raw. `activity` = flag `"1"`. `zoomed` = flag `"1"`. `dimensions` same rule. Schema marks `activity` and `zoomed` optional, relay always sends them.

PaneInfo (TM:371-390): `active` = `"1"`. `zoomed` = `window_zoomed_flag === "1" && pane_active === "1"`. `dimensions` always present. `position` `{x: pane_left, y: pane_top}`. `command` and `path` omitted when empty. `pane_active` is per window, so an unscoped `-s` listing has one active pane per window.

ScrollState (TM:694-714): `num()` is parseInt returning 0 unless finite and > 0. `application` true when `pane_in_mode !== "1"` and (`alternate_on === "1"` or `mouse_any_flag === "1"`). `historySize` forced 0 when application. `pane` is `pane_id` falling back to the session. Also `mouse`, `sgr`, `utf8`, `width`.

## 3. Errors and limits

- `TMUX_TIMEOUT = 10_000` ms, `TMUX_MAX_BUFFER = 16 MiB` on every call (TM:10,18).
- `listSessions`: error containing `"no server running"` or `"no sessions"` returns `[]`. Else rethrow (TM:90-97). Message includes stderr.
- `has-session` failing for any reason means not found (TM:156-163). `listWindows` and `listPanes` log and rethrow.
- Router: thrown error becomes `{type:"error", code:"HANDLER_ERROR", message}` (MR:1082-1094). For `repo:request` it becomes `repo:result {kind:"error"}`.
- Ownership lookup failures resolve to `SESSION_NOT_FOUND`, `PANE_NOT_FOUND` or `WINDOW_NOT_FOUND` (POL:280-308).
- Capture: `-S -2000` means 2000 history lines plus visible height. Capture failure during attach is logged, attach continues without replay (MR:236-246).
- Scroll clamps: application repeat `min(|count|, 500)`. Copy mode path not clamped, protocol limits `lines` to -500..500. Legacy mouse coordinates cap 223, or 2015 with the utf8 flag.

## 4. Attach flow

Serialisation: one message at a time per connection (CM:109-135, WC:320). Authorization first.

`session:attach` (MR:203-367):

1. Tear down existing PTY: `markDetaching()`, `kill()` (errors ignored), `pty = null`. Clear `attachedSession` and `lastSize`.
2. Name has the clone prefix, or `has-session` fails → `SESSION_NOT_FOUND` with `Session "<name>" not found`.
3. If `msg.capture`: `capturePane(name)` 2000 lines with escapes. Errors ignored.
4. Spawn PTY with `msg.size`. Synchronous spawn error → `PTY_SPAWN_FAILED`.
5. `conn.pty = bridge`, `attachedSession = name`, `lastSize = msg.size ?? null`.
6. `onData`: if `conn.pty !== bridge` drop. Else send `terminal:output {data}`. If socket buffered > 8 MiB, `pause()` and poll every 50 ms, `resume()` once at or below 1 MiB (MR:40-42, 296-332).
7. `onExit(code)`: send `session:exited {name, exitCode}`. Clear `pty`, `attachedSession`, `lastSize` only if `conn.pty === bridge`.
8. `onSpawnError`: send `PTY_SPAWN_FAILED` with the same conditional clear. PB raises it when the PTY exits before ready and not detaching: `tmux attach-session exited with code N before ready`.
9. `onReady` (first PTY data or 50 ms after spawn, PB:103-117): send `session:attached {name, attachId?}` (`attachId` only when truthy), then `terminal:output {data: captured}` if non empty. Order is ack, replay, live output.

Second attach on the same connection: step 1 silences the old bridge's exit and spawn error, data is dropped, ready is not guarded (see Port notes).

Resize (MR:455-473): requires a PTY else `NOT_ATTACHED`. Size equal to `lastSize` is dropped, including the size sent with the attach. Else update and `pty.resize`. Bounds cols 1..1000, rows 1..500.

Detach (MR:369-388): same teardown, clears unconditionally. No reply.

Session dies: attach client exits → `onExit` → `session:exited` with `exitCode` to this connection. The 5 s monitor separately broadcasts `session:exited {name}` (no exitCode) to every connection not attached to it (WC:364-372). `session:kill` sends `session:killed` to the sender and broadcasts to others (MR:390-401).

Client disconnect (WC:323-350, CM:185-230): set closing, drain, then: cancel dictation, PTY `markDetaching` and `kill` (tmux session stays alive), close watchers, clean uploads, decrement address count.

Web client sends `capture: true` and `size` on every attach, followed by `pane:list` and `window:list` (`terminal-view.tsx:805-813`).

## 5. Zoom, layout announce, scroll

`zoomPane` (TM:501-545), target `paneId ?? session`:

- `desired` undefined: `resize-pane -t T -Z` (toggle).
- Else read `display-message -p -t T "#{window_zoomed_flag}\t#{pane_active}"`. Pane counts as zoomed when flag `"1"` and pane active. If `desired` equals that, do nothing. If `desired` true and window zoomed on another pane: `select-pane -Z -t T`. Else `resize-pane -t T -Z`.

Router passes `paneId` only if `msg.id` set, `desired` only if `msg.zoomed !== undefined`, so `false` is kept (MR:800-803). Then `announceLayout`.

`announceLayout` (MR:115-142): `listWindows` and `currentWindowPanes` (`currentWindowId` then scoped `listPanes`). Send `window:changed {windows, sessionName}` then `pane:changed {panes, windowId}` to sender, then the same two in order to other connections attached to the same session. Runs after: `pane:split`, `pane:select`, `pane:zoom`, `pane:resize`, `pane:kill`, `pane:step`, `pane:swap`, `window:step`, `window:create`, `window:select`, `window:kill`, `window:rename`, `window:layout`, `layout:rotate`.

`activeWindowId` updated on `pane:select`, `window:step`, `window:create`, `window:select`, `window:kill` (only when the killed window was active).

`scrollHistory(s, lines, allowApp)` (TM:725-799): `count = trunc(lines)`, 0 → return `readScrollState`. Application mode: if `!allowApp` return state (router passes `!grant.readOnly`, always true in Go). `repeat = min(|count|, 500)`. Mouse on: button 64 up (`count > 0`), 65 down. `x = max(1, ceil(width/2))`, `y = max(1, ceil(height/2))`. SGR `ESC[<b;x;yM`. Legacy `ESC[M` then chars `b+32`, `min(x,lim)+32`, `min(y,lim)+32`, utf8 encoded if the utf8 flag else latin1. Sent with `send-keys -H` as lowercase unpadded hex. Mouse off: `send-keys -N repeat Up|Down`. Not application: `copy-mode -e` first if not in a mode, then `send-keys -X -N |count| scroll-up|scroll-down`. Both branches return `readScrollState(pane)`.

`scrollToPosition` (TM:809-820): `target = max(0, trunc(pos))`, `clamped = min(target, historySize)`, `delta = clamped - (inMode ? position : 0)`. Zero → state. Else `scrollHistory(delta)`. In application mode historySize is 0 so no-op.

Router (MR:960-1011): `tmux:scroll`, `tmux:scroll-to`, `tmux:scroll-state` reply `tmux:scroll-state {position: inMode ? position : 0, historySize, paneHeight, inMode}` (MR:53-61). `tmux:exit-copy-mode` calls `exitCopyMode` then sends a fresh state. `tmux:copy-mode` no reply. All require attached (`NOT_ATTACHED`).

## 6. Session monitor

- `SESSION_POLL_MS = 5000`, `WINDOW_POLL_MS = 1000` (SM:66-68). `start()` runs both immediately then on intervals.
- Session poll (SM:124-151): `knownSessions` set of names, clones included. Missing known name → `onSessionExit`, removed. New name → `onSessionCreated` (first poll: every session). `listSessions` returns `[]` with no server, so every known session counts as exited. Rename shows as exit plus create.
- Window poll (SM:84-122): watched sessions are unique non null `attachedSession` across connections (WC:97-104). Signatures for unwatched sessions dropped. Sessions polled one after another, each `listWindows` and unscoped `listPanes` together. Window part `id:index:name:active:paneCount:zoomed:layout` joined `|`. Pane part `id:windowId:active:path` joined `|`. Halves joined with `#`. First signature seeds baseline silently. Change fires `onWindowsChanged(name, windows)`. Error deletes the signature. Reentrancy flag skips a tick while the previous poll runs. No time debounce.
- Messages (WC:364-417, via `broadcastWhere`, skips unauthenticated and clone names): exit → `session:exited {name}` to connections not attached to it; windows changed → `window:changed {windows, sessionName}` to attached connections then async `currentWindowPanes` and `pane:changed {panes, windowId}` to the same, errors swallowed; created → `session:created {session}`.

## 7. Ownership rule (POL:238-257)

- Pane id messages: `repo:request`, `pane:select`, `pane:resize`, `pane:kill`, `pane:swap`, `pane:capture`. Go adds `pane:zoom` when `id` is set.
- Window id messages: `window:select`, `window:kill`, `window:rename`.
- Checks in order: `msg.id` missing or not a string is refused by the hub decoder as `INVALID_MESSAGE` before the node sees it (Go); an empty string id reaches the node and is looked up like any other id; no `attachedSession` → `NOT_ATTACHED` "No session attached"; pane ids must appear in unscoped `listPanes(attached)`, window ids in `listWindows(attached)`; failure → `PANE_NOT_FOUND` `Pane "<id>" not found` or `WINDOW_NOT_FOUND` `Window "<id>" not found`.
- Earlier gates that survive: unknown type → `UNKNOWN_MESSAGE`. Grant gates collapse (full grant).
- Not checked: relative step messages, `pane:split`, `window:create`, layout messages, `session:windows`.

## 8. `__tmuxde_` filter and sweep

- `CLONE_PREFIX = "__tmuxde_"` (TC:17), `isCloneSession` uses `startsWith`.
- Filter points: `sessionsVisibleTo` for `session:list` and rename reply (MR:72-73); `canSee` for `session:created` and `session:killed` broadcasts (MR:80); attach target refused as `SESSION_NOT_FOUND` (MR:225-226); rename broadcast list (MR:422-424); monitor handlers (WC:365,378,411).
- Not filtered: `session:kill`, `session:rename`, `session:windows` by name, monitor `knownSessions`.
- Sweep: WC:423-425 runs `sweepOrphanClones` once after `monitor.start()`. Lists `list-sessions -F "#{session_name}"` and kills each prefixed one (TC:123-144). Returns 0 if listing fails.

## 9. Test inventory

`tmux-manager.test.ts`, real tmux, skipped if `tmux -V` fails. Suite timeout 30 s, `beforeAll` 90 s. Socket: `realpath(mkdtemp(tmpdir/"relay-tmux-"))`, socket `base/sock`, config `base/tmux.conf` with `set -g history-limit 200000`. Fixture commands `tmux -f conf -S sock ...`. Session `relay-capture-fixture`: `new-session -d -s ... -x 200 -y 50 "sh fixture.sh"`, script prints 12,000 lines of 120 `x`, then a red `COLOURED-MARKER`, then `sleep 600`. Setup polls `capture-pane -S -5` every 100 ms up to 60 s until the marker appears. `afterAll` runs `kill-server` and removes the directory.

- capturePane: has a fixture that would overrun the default 1 MiB maxBuffer; returns bounded output instead of throwing; honours an explicit line bound; keeps SGR escapes by default so colours survive the replay; can omit escapes for plain-text consumers
- capturePaneById: is bounded and plain-text by default (copy-mode overlay)
- scrollHistory (`afterEach` exitCopyMode): enters copy mode by itself and moves back through history; accumulates across the several messages one drag produces; scrolls forward again on a negative count; clamps at the top of the history rather than failing; does nothing at all for a zero count; leaves copy mode on request, so typing works again; is a no-op when asked to leave copy mode it is not in; returns the position it reached, which is what the scrollbar draws; reports a pane outside copy mode as being at the bottom; jumps to an absolute position from anywhere, in either direction; takes a jump to 0 back to the live output; clamps a jump past the oldest line to the top of the history
- splitPane (fixture `relay-split-fixture` with `-c folder "sleep 600"`): starts the new pane in the folder of the pane it splits
- windows and panes (fixture `relay-window-fixture` 200x50, 2 new windows, 2 splits):
  - zoom (`afterEach` unzooms by pane id): zooms the pane it was told to, not the one tmux had active; is idempotent, so a double tap does not undo itself; unzooms idempotently too; moves the zoom to another pane rather than turning it off; still toggles when no state is asked for, for an older client; reports zoom on the window, where a layout string cannot; says false for a window with nothing zoomed in it
  - reports the window tmux is actually showing; shows the window of a pane selected through its session; returns exactly one active pane when scoped to a window; returns one active pane PER WINDOW when unscoped; marks only the zoomed AND active pane as zoomed; steps windows forwards and wraps; steps windows backwards; steps panes inside the current window without leaving it; keeps the window zoomed across a pane step
- application scrolling (python3 raw tty app in `new-window -d -P -F "#{pane_id}"`, modes `sgr`, `legacy`, `keys`, `inline`, records stdin to a file, `afterEach` kill-pane): routes mouse scrolling into app without copy mode (sgr and inline); sends a long flick as one repeated event (500 events); encodes legacy mouse wheel bytes (6 bytes starting `[27,91,77,96]`); uses arrow keys for alternate-screen apps without mouse support (`\x1b[A\x1b[A\x1b[B`); does not send application input for a read-only viewer (collapse); keeps explicit copy mode available over a TUI

`session-monitor.test.ts`, mocked tmux, fake timers, "session monitor window poll": stays quiet while nothing moves; announces focus moved to another pane within a second; announces a folder change in a pane

`message-router.test.ts`, mocked tmux, pty, files, repo. Terminal parts:

- session:attach: acks before replaying the capture; echoes the attachId so the client can reject stale acks; still attaches when the capture fails; leaves no stale attachedSession when the session is gone; leaves no stale attachedSession when the PTY fails to spawn
- session:detach: clears attachedSession even with no live PTY
- terminal:resize: applies a changed size once and drops the repeats; drops a resize that matches the size sent with the attach
- scoped grants (keep these): refuses to capture a pane outside the attached session; still captures a pane that does belong to the session; refuses a second auth frame instead of rubber-stamping it
- tmux:scroll: scrolls the session the connection is attached to; passes a negative count through, so scrolling back down works; refuses when nothing is attached rather than guessing a session; reports where the view ended up, so the scrollbar can draw itself; jumps to an absolute position for a scrollbar drag; answers a bare state request without moving anything; reports position 0 outside copy mode, whatever tmux last remembered; leaves copy mode on request; refuses to leave copy mode with nothing attached
- window scoping: scopes pane:list to the window tmux is actually showing; does not snap the window back to the first one after window:select; selects a pane through the attached session, so its window shows; publishes the window list alongside every pane change; passes the pane and the wanted state through to tmux; asks for a toggle when an older client names neither; carries `zoomed: false` rather than dropping it as falsy; steps windows relatively, so a stale client list cannot mistarget; steps backwards on a negative delta; steps panes within the current window only; refuses to step with nothing attached
- repository request routing: refuses panes outside attached session. policy.test.ts: refuses a pane id with no attached session; refuses a pane message with no id at all; never leaks a session name through the refusal code

## Comments that record past bugs

- TM:12-18: 32 MB capture aborted attach. 16 MiB buffer plus 2000 line bound.
- TM:242-246, SM:29-40: `window_layout` is identical zoomed and unzoomed, so a pane unzoomed outside the browser stayed drawn as zoomed. `zoomed` and `layout` in the signature.
- TM:262-265, MR:91-97: `pane_active` is per window, the guess always resolved to the first window. `currentWindowId` plus scoped `list-panes`.
- TM:293-296, TM:468-470: `select-pane -Z` replaces the unzoom, select, rezoom triple.
- TM:442-446: a pane selected off screen left the screen in place, a split landed in the wrong window. `select-window` through the session.
- TM:481-496: zoom toggle raced, two taps left the opposite state. `desired` state.
- TM:757-760: hex `send-keys` rejected as too long under a hundred events. `-N`.
- SM:52-57: browser kept browsing the folder of a pane no longer active. Pane signature.
- SM:111-112: concurrent polls left an older signature behind. Reentrancy guard.
- MR:204-207: stale `attachedSession` pointed handlers at a dead session.
- MR:232-235: capture failure left a dead terminal.
- MR:293-295: late `onExit` nulled a newer PTY.
- MR:352-354: capture ahead of the ack was always discarded, first paint blank.
- MR:460-462: no-op resizes caused global SIGWINCH redraws.
- MR:1057-1068: a second `auth` was rubber-stamped.
- POL:31-33: `capturePaneById("%7")` resolved server wide.
- WC:384-395: sending the window half alone left a pane drawn as zoomed.
- CM:200-201: clone destroyed after the PTY dies, or tmux would reattach.
- PB:128-131: PTY exit before ready is a spawn error, not a phony ready.
