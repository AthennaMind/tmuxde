# Porting spec: relay dictation bridge and stt unix socket

Source of truth for phase 6 of [go-single-binary.md](go-single-binary.md). Extracted 2026-10-12 from the relay and stt sources by a read-only scout. Line numbers at extraction time. Relay file is `apps/relay/src/dictation.ts` unless stated.

## Port notes (differences the Go port should make on purpose)

- Base64: Node decodes leniently, accepts missing padding and drops a trailing partial group. Go `base64.StdEncoding` rejects both. Strip `=` and use `RawStdEncoding`, tolerate length 1 mod 4 by dropping the tail, to match.
- Probe stop race: `stop()` sets `available=false` but an in flight fetch still writes `available = ok` afterwards (:264). Go: check stopped before writing.
- Transport: Go dials the stt unix socket with a custom dialer and any host in the URL, e.g. `ws://stt/v1/stream`. Health probe over the same socket with an `http.Transport` whose `DialContext` opens the unix path.
- Grant checks collapse. `dictation:start` and `dictation:audio` are writes, always allowed with the full grant.

## 1. Relay bridge

Per connection state: one slot `conn.dictation: DictationSession | null` (connection-manager.ts:58-59, nulled at :156). Session `{id, socket, early: Buffer[], earlyBytes, stopRequested, opened, ended, timer}` (:28-38). No global cap in the relay, only stt `maxSessions`.

Constants: `MAX_BUFFERED_BYTES = 1 MiB` (:23), `MAX_SESSION_MS = 15 min` (:25), `CONNECT_TIMEOUT_MS = 5000` (:26), inbound `maxPayload` from stt 256 KiB (:98).

Routing (message-router.ts:512-526): rate limit then schema check then the per connection queue. Browser frames capped at 1 MiB.

Client schemas (client-messages.ts:349-386): `id` 1 to 64 chars. `pcm` string at most 65536 chars matching `^[A-Za-z0-9+/]*={0,2}$`. Length mod 4 not enforced.

`dictation:start` (:79-169):

- Existing session is ended silently (:85). Old id gets no message.
- `STT_URL` unset → `UNAVAILABLE` / "Dictation is not enabled on this machine" (:86-94), no session.
- Relay tries to connect even when the probe says down (:72-78).
- Dials `/v1/stream` on the stt URL (:45-47). No headers, no subprotocol, no auth, no permessage-deflate.
- 15 minute timer fires `FAILED` / "Dictation ran too long" (:108-111).

Socket open (:115-121): set `opened`, send each early frame as its own binary message, then text `{"type":"stop"}` if stop was requested while connecting. Relay does not wait for stt `ready` before forwarding audio.

Messages from stt (:123-148): binary and anything after `ended` ignored. Text parsed as JSON, checked against a union (:15-20), text limited to 20,000 chars, extra fields allowed. Parse or schema failure → `FAILED` / "Speech service sent nonsense".

| stt message | Relay action |
| --- | --- |
| `ready` | send `dictation:ready` |
| `text` | send `dictation:text` with `text` unchanged |
| `done` | `end()` (close 1000) then send `dictation:done` |
| `error` | send `FAILED` with stt `message` passed through, stt `code` dropped |

Close (:150-157), if not already ended: code 1013 → `BUSY` / "Speech service is busy. Try again shortly."; any other → `FAILED` / "Speech service closed the connection".
Error (:159-168): if `opened` → `FAILED` / "Lost the speech service"; else `UNAVAILABLE` / "Speech service is not reachable" (refused, 404 on upgrade, handshake timeout). Comment :160: close code cannot tell never reached from dropped.

`end()` (:49-58) idempotent: set `ended`, clear timer, drop early frames, null the slot if it still holds this session, `close(1000)` if OPEN or terminate if CONNECTING. `fail()` (:60-70) is `end()` then `dictation:error`. Every error is final.

`current()` (:171-185) requires a slot that exists, matching id, not ended. Else `NOT_FOUND` / "No dictation is running". Frames after done or error each get `NOT_FOUND`.

`dictation:audio` (:188-213): dropped silently if stop requested. Decode base64, empty result dropped. CONNECTING: add to `earlyBytes`, over 1 MiB → fail `OVERLOADED` / "Speech service is not keeping up", else queue. OPEN: if `bufferedAmount` over 1 MiB before adding → fail `OVERLOADED`, else send binary. Odd length frames forwarded as is, stt rejects as `BAD_AUDIO`, browser sees `FAILED` / "Audio must be 16-bit PCM".

`dictation:stop` (:216-227): `current()` check, no-op if repeated. Set `stopRequested`, send text `{"type":"stop"}` if OPEN, else on open. No timeout waiting for `done` beyond the 15 minute timer.

`dictation:cancel` (:230-233): `end()`, no reply. Mismatched id or no session ignored silently.

Disconnect: `removeConnection` calls `cancelDictation(conn)` first (connection-manager.ts:185-187), after the queue drains.

Error codes (server-messages.ts:360-372): `UNAVAILABLE`, `BUSY`, `OVERLOADED`, `NOT_FOUND`, `FAILED`. `message` is safe to show.

## 2. Health probe (:235-276)

- URL `/health` on the stt base with `ws` replaced by `http`. Only 2xx is checked, body ignored.
- Timeout 3000 ms. First check immediately. Next 30 s later when up, 5 s when down. Logs "Speech service availability changed" on change.
- No URL: probe does nothing, flag stays false.
- Started in `wireConnections` (wire-connections.ts:448-449), stopped in shutdown (:469). Single module level flag.
- `auth:success.features` gets `"dictation"` appended while available (wire-connections.ts:276-278). Computed once at login, never pushed on change. Compose therefore makes the relay wait for stt health so reconnecting phones keep the mic.

## 3. stt service (`apps/stt/src/server.ts`, `index.ts`, `config.ts`, `session.ts`)

Routes: `GET /health` exact match → 200 `application/json` `{ok:true, model:<basename of STT_MODEL_DIR>, sessions:<active>}` (:32-37). Other requests 404 empty (:38). Upgrade on any path other than exactly `/v1/stream` → raw `HTTP/1.1 404 Not Found` and socket end (:41-45). `WebSocketServer({noServer:true, maxPayload: 256 KiB})`. At the session limit the handshake completes then `close(1013,"Busy")` (:47-50). No auth.

Frames in: binary is signed 16-bit little-endian mono PCM at 16 kHz (pcm.ts). Odd byte count → `BAD_AUDIO` / "Audio must be 16-bit PCM". Only valid text is `{"type":"stop"}`, anything else → `BAD_MESSAGE` / "Expected audio or stop". Everything after stop ignored.

Frames out (JSON text): `{"type":"ready"}` right after setup. `{"type":"text","text"}` per decoded piece, empty not sent. `{"type":"done"}` then `close(1000,"done")`. `{"type":"error","code","message"}` then `close(1011, code)`. Codes `BAD_AUDIO`, `BAD_MESSAGE`, `DECODE_FAILED` ("Speech could not be transcribed"), `IDLE` ("No audio received").

Limits: `STT_MAX_SECONDS` default 600 (10 to 3600), at the cap keeps what fits then stops. Idle timeout 60 s hardcoded (index.ts:25), resets per message. `STT_MAX_SESSIONS` default 4 (1 to 64). Pieces under 1600 samples skipped. Decodes serialised across sessions.

Binding: `STT_HOST` default `127.0.0.1`, `STT_PORT` default `24400`, `server.listen(port, host)` at index.ts:27-29. SIGTERM and SIGINT close the server, force exit after 2 s.

Unix socket change list:

- `config.ts`: add `STT_SOCKET` path. When set it wins over host and port.
- `index.ts:27-28`: `server.listen({ path })`, fix the log line.
- Unlink a stale socket file before listening. SIGKILL or OOM kill (container `mem_limit: 3g`) leaves the file, next listen fails with EADDRINUSE. `server.close()` unlinks promptly in the normal case.
- Socket mode from umask. Both containers and the host binary run as the same uid. Keep the path under 108 bytes.
- `ws` works unchanged over a unix listener. Nothing checks the Host header.
- `server.test.ts` listens on `127.0.0.1:0` directly on `createSttServer`, unaffected.

Docker pieces to replace:

- `.docker/prod/stt.Dockerfile:29-33`: `ENV STT_HOST STT_PORT`, `EXPOSE 24400`, `HEALTHCHECK` fetch on the TCP port.
- `dev.yaml`: stt healthcheck (:144-152), `STT_HOST` and `STT_PORT` env (:163-164), `networks: speech` (:155-156), relay `STT_URL` (:100) and relay `networks: speech` (:77), network definition (:8-11).
- `prod.yaml`: stt `networks: [speech]` (:98), relay `networks: [offline, speech]` (:73), `STT_URL` (:49), network definition (:131-133).
- `.docker/dev/setup.py:115` writes `STT_URL=ws://stt:24400`. Becomes a socket path.
- Replacement healthcheck without TCP: `node -e "process.getBuiltinModule('node:http').get({socketPath:'<path>',path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"`.
- `network_mode: none` cannot be combined with a `networks:` key. Prod is `read_only: true`, so the socket directory must be a writable bind mount shared with the host (`~/.local/state/tmuxde/run/`). Once the relay moves to the host the relay `depends_on` on stt goes away.

## 4. Test inventory

`dictation.test.ts`, "dictation forwarding":

1. says unavailable when dictation is not configured
2. says unavailable when the service cannot be reached
3. forwards audio and stop, then relays text and done
4. holds audio sent before the service connection opens
5. reports a busy service
6. passes a service error on as failed
7. does not trust malformed service messages
8. answers audio for a dictation that is not running
9. cancels quietly and closes the service session
10. ignores a cancel for another dictation
11. replaces a running dictation when a new one starts
12. ends a dictation that runs past its limit

"speech service probe":

13. offers dictation while the service is healthy
14. withholds dictation while the service is unhealthy
15. does nothing without a configured service

`apps/stt/src/server.test.ts`, "speech service": answers health checks with the model name; refuses WebSocket upgrades on any other path; transcribes audio after stop, then says done and closes; skips a tail too short to be speech; decodes full chunks while audio is still arriving; stops by itself at the length limit and keeps what fits; rejects audio that is not whole 16-bit samples; rejects text that is not stop; reports a failed decode; closes a session that goes quiet; turns away sessions over the limit. "serialize": runs one decode at a time in arrival order; keeps going after a failure.

## Comments that record past bugs

- dictation.ts:160: close code cannot distinguish unreachable from dropped, so the `opened` flag decides.
- connection-manager.ts:186: a closed tab could keep a service slot, dictation is cancelled on disconnect.
- config.ts:54: compose passes an empty string when dictation is off, hence `|| undefined`.
- dev.yaml:83-85, prod.yaml:32-34: browsers reconnecting during a model load lost the mic, fixed by waiting on stt health.
- segmenter.ts:31-34: VAD clipped soft first sounds, fixed with 0.3 s pre-roll. stt internals, unchanged by this plan.
