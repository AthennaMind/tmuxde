# Porting spec: relay HTTP and WebSocket lifecycle

Source of truth for phase 3 of [go-single-binary.md](go-single-binary.md). Extracted 2026-10-12 from the relay sources by a read-only scout. References use bare file names under `apps/relay/src/` and line numbers at extraction time. Dropped items (pairing, device approval, gate, grants beyond full) are listed only where their absence changes behaviour.

## 1. Constants and timeouts

| Item | Value | Ref |
| --- | --- | --- |
| Inbound frame cap | `MAX_PAYLOAD = 1024*1024`. Exceeding closes with 1009 "Max payload size exceeded" (library behaviour) | ws-server.ts:11,37,55 |
| Global connection cap | 100. `getConnectionCount() >= 100`, counts unauthenticated sockets too | wire-connections.ts:61,117 |
| Per address cap | 10, keyed on raw `remoteAddress` (fallback `"unknown"`, also counted). `::ffff:` not stripped | wire-connections.ts:62,109,122; connection-manager.ts:178-180,222-226 |
| Over a cap | After the handshake, so a close not an HTTP reject: `close(1013,"Server at capacity")` or `close(1013,"Too many connections from your address")`. Never registered | wire-connections.ts:119,124 |
| Rate limit | Fixed 1000 ms window, not a token bucket. `count++` then `count <= limit`. Limit `WS_RATE_LIMIT`, default 100. Every frame, before and after auth | rate-limiter.ts:9-21; config.ts:20 |
| Auth timeout | 5000 ms from connection. Cleared only when the first frame passes rate limit and parsing (wire-connections.ts:187). Rate limited or invalid frames do not clear it | auth.ts:19,124-129; wire-connections.ts:142 |
| Liveness | `setInterval` 30_000 after auth. Tick: `isAlive===false` → `terminate()`, else `isAlive=false` and `ping()`. Pong sets true. Dead peer dropped after 30 to 60 s. Pongs do not update `lastActivityAt` | wire-connections.ts:137-140,306-315 |
| Idle timeout | `IDLE_TIMEOUT_MINUTES` default 30, swept every `IDLE_SWEEP_MS=60_000`. `<=0` disables. Against `lastActivityAt`, set on every inbound message including dropped, rate limited and invalid ones. Action `close(1000,"Idle timeout")` | config.ts:21; wire-connections.ts:66,161,436-446 |
| Shutdown grace | `CLOSE_GRACE_MS=250`. All sockets `close(1001,"Server shutting down")`, `terminate()` after 250 ms, then server close | wire-connections.ts:74,466-483 |
| Close handshake | No repo constant. `ws@8` default 30000 ms | package.json |
| Auth throttle | `FAILURES_BEFORE_LOCKOUT=5`, `BASE_LOCKOUT_MS=30_000`, `MAX_LOCKOUT_MS=900_000`, `ENTRY_TTL_MS=3_600_000`, `MAX_ENTRIES=10_000`. Sweep runs once the map has 256 or more entries, evicts oldest by `touchedAt` | auth-throttle.ts:15-22,39-54 |
| Lockout schedule | Failures 1 to 4: none. 5th: 30 s, 6th: 60 s, 7th: 120 s, 8th: 240 s, 9th: 480 s, 10th on: 900 s cap. Success deletes the entry. Null address never throttled. While locked, attempts refused without recording a failure | auth-throttle.ts:84-98,102-105; auth.ts:85-95 |
| Capture | `DEFAULT_CAPTURE_LINES=2000` (`capture-pane -t X -p [-e] -S -2000`). Escapes on for attach replay, off for `pane:capture`. `TMUX_MAX_BUFFER=16 MiB`, `TMUX_TIMEOUT=10_000` per exec | tmux-manager.ts:10,18,23,40-55,191-203,403-415 |
| Related | Session poll 5000 ms, window poll 1000 ms (session-monitor.ts:66,68). File limits read 100 KB, write 1 MB, upload 10 MB (file-service.ts:12-14). STT probe 3 s fetch timeout, every 30 s when up, 5 s when down (dictation.ts:256,266) | |

## 2. Connection state machine (wire-connections.ts:107-355)

Upgrade: origin check first (section 3).

Caps: over a cap → close 1013, stop. Else `createConnection` assigns id `conn-N` (monotonic), increments the address count, sets `connectedAt` and `lastActivityAt` (connection-manager.ts:102-183). `transport` and `userAgent` captured from the upgrade request.

UNAUTH, 5 s timer. Per frame, in order:

1. `lastActivityAt = now`.
2. Rate limit fails → send `{"type":"error","code":"RATE_LIMITED","message":"Too many messages"}`, stay open.
3. Parse fails → send `{"type":"error","code":"INVALID_MESSAGE","message":<parse or zod error text>}`, stay open.
4. Clear auth timer, run `authenticateMessage` (auth.ts:77-122):
   - type not `auth` → `auth:failure` reason `"First message must be auth"`.
   - throttled → reason `Too many failed attempts. Try again in ${ceil(ms/1000)}s.`
   - token mismatch (SHA-256 both sides then constant time compare, auth.ts:55-68) → record failure, reason `"Invalid token"`.
   - fallback reason `"Authentication failed"` (wire-connections.ts:196).
   - each failure followed by `ws.close()` with no code.
5. Auth timer fires → `{"type":"auth:failure","reason":"Authentication timeout"}`, then close.

Gate step (dropped in Go): every connection is admitted.

AUTHENTICATED. Set `authenticated`, `grant` (always full), `label`. Then in order: notify connections changed, access log `connected`, send `auth:success`, send `server:info`, start ping interval.

After that every frame: rate limit, parse, then `conn.enqueue(routeMessage)` on a serial per connection queue (connection-manager.ts:109-142). Router errors:

- second `auth` → `ALREADY_AUTHENTICATED` "This connection is already authenticated." (message-router.ts:1053-1075)
- unknown type: unreachable in the relay, Zod rejects it first as `INVALID_MESSAGE` with the parse text. Go does the same, before and after auth. The web client swallows only `INVALID_MESSAGE` during its scroll state probe (`use-websocket.ts:436`)
- thrown handler → `HANDLER_ERROR` with the error message
- other codes in use: `ACCESS_DENIED`, `READ_ONLY`, `NOT_ATTACHED`, `SESSION_NOT_FOUND`, `PANE_NOT_FOUND`, `WINDOW_NOT_FOUND`, `ATTACH_FAILED`, `PTY_SPAWN_FAILED`, `WATCH_FAILED`

CLOSED (close event, :323-350), in order:

1. Clear auth timer.
2. `closing=true` (enqueue becomes no-op).
3. `await drain()`.
4. If authenticated: access log `disconnected` with `seconds = round((now - connectedAt)/1000)`. `connectedAt` is accept time.
5. `removeConnection`: cancel dictation, kill PTY, close watchers, clean up uploads, decrement address count, delete entry.
6. If authenticated: notify connections changed.

`error` event is only logged. `sendJson` sends only when OPEN and does not check `bufferedAmount` (ws-server.ts:99-103).

## 3. Origin check

- `CORS_ORIGINS` default `"http://localhost:14100"`, split on `,`, trimmed, blanks dropped (config.ts:31-41). Production startup throws if any entry starts with `http://localhost` (:73-81).
- WS rule `isOriginAllowed` (ws-server.ts:18-22): missing Origin → allow. Empty list → allow. Else exact string match, no case or trailing slash normalisation.
- Mismatch: `verifyClient` → HTTP 403 body "Forbidden origin" (ws-server.ts:38-48). No path filter in the standalone relay, Caddy forwards `/_relay`. Go: upgrade only on `/_relay`.
- No WS close code for origin, upgrade never completes.
- HTTP (server.ts:509-520): `Access-Control-Allow-Origin` echo, `-Methods: GET, OPTIONS`, `-Headers: Content-Type` only on exact match. `OPTIONS` on any path → 204 before routing. Same origin behind Caddy, so Go may answer 204 to OPTIONS and skip ACAO entirely.

## 4. auth:success and server:info (wire-connections.ts:265-291)

```json
{"type":"auth:success","serverVersion":"1.0.0",
 "capabilities":{"readOnly":false,"files":"write","scope":"all"},
 "features":["repo:request","repo:history","file:upload:ack","window:step","pane:step","dictation"]}
```

- `SERVER_VERSION` "1.0.0" (:41). `FEATURES` (:51-57). `"dictation"` only when `dictationAvailable()`: `STT_URL` set and health probe ok (dictation.ts:235-275).

```json
{"type":"server:info","hostname":"<os.hostname()>","platform":"linux","uptime":<system uptime seconds>,"defaultPath":"<path>"}
```

- `defaultPath` is `path.resolve(config.allowedPaths[0] ?? $HOME ?? "/")` (file-service.ts:29-31).

## 5. /file (server.ts:544-661)

- Match `req.url.startsWith("/file?")` and GET. Else 404 "Not found" (:666-673).
- Headers on this route: `Allow-Methods: GET, OPTIONS`, `Allow-Headers: Content-Type, Authorization` always set.
- Query: `path`, `token` (deprecated, warn log when used without bearer), `download` (`"1"` means attachment).
- Token: `Bearer ` prefix case sensitive, bearer wins over query. No auth throttle on `/file`.

Checks in order:

1. No token or mismatch → 401 "Unauthorized".
2. (gate, dropped)
3. (files none, dropped, full grant always has write)
4. No `path` → 400 "Missing path parameter".
5. `!isPathAllowed(path)` → 403 "Access denied". Realpath with parent fallback for missing files, denied roots `$TMUXDE_CONFIG_DIR`, `~/.tmuxde`, `~/.tmuxremote`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.kube`, then must be within an `ALLOWED_PATHS` entry (file-service.ts:71-124).
6. `stat` not a regular file → 404 "Not a file". Any thrown error → 404 "File not found".

Response:

- `Content-Type` from mime.ts, `Cache-Control: private, max-age=60`.
- MIME (mime.ts:3-31), lowercased extension: png, jpg, jpeg, gif, svg, webp, bmp, ico, mp4, webm, mov, mp3, wav, ogg, flac, m4a (`audio/mp4`), aac, pdf. Else `application/octet-stream`.
- Download: `attachment; filename="<name with [\u0000-\u001f\u007f"\\] replaced by _>"; filename*=UTF-8''<encodeURIComponent(name)>` (:498,619-627).
- Range: regex `/bytes=(\d+)-(\d*)/` unanchored, first range only. Suffix ranges get a plain 200. `start >= size` → 416 with `Content-Range: bytes */<size>`. Else `end` clamped to `size-1` → 206 with `Content-Range: bytes s-e/size`, `Content-Length`, `Accept-Ranges: bytes`. `end < start` not validated.
- Normal: 200 with `Content-Length` and `Accept-Ranges: bytes`. No ETag or Last-Modified.

## 6. /health (server.ts:522-526)

Exact `req.url === "/health"` (query causes 404). Any method except OPTIONS. No auth. 200 `application/json` body `{"status":"ok","uptime":<process uptime seconds, fractional>}`.

## 7. Access log (access-log.ts)

- Location `$TMUXDE_CONFIG_DIR/access.log`, else `~/.tmuxde/access.log`, resolved per call (:37-40).
- mkdir recursive 0700, append `JSON.stringify(event)+"\n"` mode 0600, chmod 0600 each time. Errors swallowed and warned once per process (:116-132). Never awaited.
- Key order: `at` (ISO-8601 ms, `Z`), `event`, `grantId`, `scope`, `readOnly`, `files`, `label`, `transport`, `seconds` (disconnect only).
- Full grant → `grantId:null`, `scope:"all"`, `readOnly:false`, `files:"write"` (:90-102).
- Writes: `connected` after auth (wire-connections.ts:257), `disconnected` on close if authenticated (:333). Never for bad tokens, timeouts, caps or file serves. UA not logged.
- `transportFor` (:78-88): UA exactly `"mtmux-tunnel-agent"` → `tunnel` (dropped in Go). Null address → `loopback`. Strip `^::ffff:`, then `127.0.0.1`, `::1`, `localhost` → `loopback`. Else `lan`, including `"unknown"`.
- `readAccessLog` skips blank and unparsable lines (:135-155).
- UA parsing (user-agent.ts:23-63), first match in ordered tables. Browsers: Edge `/\bEdg[A-Z]?\//`, Opera `\bOPR\/`, Samsung Internet `\bSamsungBrowser\/`, Vivaldi, Brave, Chrome `\b(?:CriOS|Chrome|Chromium)\/`, Firefox `\b(?:FxiOS|Firefox)\/`, Safari `\bSafari\/`. Platforms: iPhone, iPad, Android, Windows `\bWindows NT\b`, Linux `\b(?:Linux|X11)\b`, Mac `\b(?:Macintosh|Mac OS X)\b`. Output `"B on P"`, or the matched half, or null. Used only for label fallback `label ?? describeUserAgent(ua) ?? "A device"` (connection-manager.ts:376).

## 8. Broadcast behaviour

`broadcastWhere` skips unauthenticated connections and the excluded socket. A builder that throws skips only that connection (connection-manager.ts:463-480).

- Monitor `session:exited` → all authenticated not attached to that session (wire-connections.ts:364-372). The attached connection gets its own `session:exited{name,exitCode}` from the PTY exit (message-router.ts:335).
- Monitor `session:created` → all authenticated (:410-417).
- Router `session:created` and `session:killed` → sender directly, others if `canSee` (clone filter), excluding sender (message-router.ts:193,393).
- Router rename → each other connection gets its own filtered `session:list` (message-router.ts:423-435).
- Attached session only: monitor `window:changed{windows,sessionName}` then async `pane:changed{panes,windowId}` (failure swallowed) (:377-408). `announceLayout` → sender plus others attached to the same session (message-router.ts:133-140). `terminal:output` and `session:attached` only to the requesting socket.
- Not wired: monitor activity callback has no subscriber, no `session:activity` broadcast.
- `__tmuxde_` filter points: `CLONE_PREFIX`, `isCloneSession` (tmux-clone.ts:17,24). Monitor callbacks wire-connections.ts:365,378,411. Router `sessionsVisibleTo` (message-router.ts:73), `canSee` (:80), attach to a clone → `SESSION_NOT_FOUND` (:226), rename list (:423). Startup `sweepOrphanClones` (wire-connections.ts:423; tmux-clone.ts:138).

## 9. Test inventory

auth.test.ts, "timingSafeEqualToken":

1. accepts an exactly-matching token
2. rejects a wrong token of the same length
3. rejects a wrong token of a different length
4. rejects an empty provided token
5. handles both sides empty (degenerate) as equal

auth-throttle.test.ts, "auth throttle" (address `192.168.1.50`, T0 `1_700_000_000_000`):

1. allows attempts from an address it has never seen
2. allows the first four failures without locking out
3. locks out for 30s on the fifth failure
4. lets the address back in once the lockout elapses
5. doubles the lockout on each further failure
6. caps the lockout at 15 minutes
7. clears the whole history on a success
8. tracks addresses independently
9. never throttles when the address is unknown

ws-server.test.ts, "attachUpgrade" (upgrade path routing, keep the idea: only `/_relay` upgrades, other upgrade paths go to the dev proxy or are destroyed):

1. routes the relay path to the relay
2. destroys other paths when there is no fallback
3. hands other paths to the fallback when one is given
4. still keeps the relay path for itself when a fallback exists

connection-manager.test.ts (scope parts collapse to full grant):

- "scoped broadcasts": delivers a session event to one scope and not the other (collapse); skips connections that have not authenticated; honours the exclusion, so an actor is not told its own news twice; keeps delivering when one connection's builder throws; gives a full grant everything a scoped one is denied (collapse)
- "connectionSummary": is empty before anything authenticates; counts authenticated connections only; falls back to a neutral label rather than naming nothing; orders oldest first
- "onConnectionsChanged": notifies subscribers and stops after unsubscribe; survives a listener that throws
- "disconnectConnection": closes the socket and drops it from the list; closes only the socket named; reports false for an id that is not connected

server.gate.test.ts (gate dropped, keep): still answers 401 for a bad token; `/etc/shadow` style path → 403 "Access denied".

access-log.test.ts:

- "transportFor": calls a loopback peer loopback; calls anything else lan
- "describeGrant": records the full grant as scope all with no id
- "record and read back": appends NDJSON at 0600 and reads it back in order; returns nothing when the log does not exist yet; skips a truncated final line rather than refusing the whole file; never throws when the log cannot be written

user-agent.test.ts, "describeUserAgent":

1. names the browser and the platform
2. is not fooled by a browser claiming to be another
3. says whichever half it is sure of
4. admits when it does not know

## Comments that record past bugs

- server.ts:435-441: `/file` accepted any live token from any address. Keep the bearer check strict.
- wire-connections.ts:358-362: monitor events used to iterate raw clients and leaked across scopes. Go through the connection registry.
- wire-connections.ts:394-395: sending the window half alone left a pane drawn as zoomed after unzoom. Send windows then panes.
- wire-connections.ts:456-459: with one tab open the server close never fired and Ctrl+C hung. Close then terminate after 250 ms.
- connection-manager.ts:43-47: forwarding identical resizes made tmux redraw globally, reads as flicker. Dedupe resizes.
- config.ts:34-35: filter blanks so `""` does not become `[""]` and reject everyone.
- tmux-manager.ts:12-17: a 32 MB capture aborted attach. 16 MiB cap plus bounded captures.
- ws-server.test.ts:9-14: a mis-routed HMR upgrade hung and Chromium never attempted `/_relay`. Dev proxy must forward non relay upgrades.
