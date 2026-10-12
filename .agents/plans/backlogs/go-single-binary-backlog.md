# Go single binary backlog

Plan: [../go-single-binary.md](../go-single-binary.md). Review: [../../reviews/go-single-binary-plan-review.md](../../reviews/go-single-binary-plan-review.md).

## Progress summary

| Phase | Status |
| --- | --- |
| 0. Decisions and audit | [x] |
| 1. Go toolchain, vendoring, module skeleton | [x] |
| 2. Protocol contract and pty spike | [x] |
| 3. HTTP, dev proxy and WebSocket lifecycle | [x] |
| 4. Terminal | [x] |
| 5. Files and repository | [x] |
| 6. Dictation | [x] |
| 7. Parity against current web | [x] |
| 8. Web to Vite SPA | [x] |
| 9. Embed, binary build, second parity | [x] |
| 10. Host service and cutover behind Caddy | [x] |
| 11. Development instance on 18443 | [x] |
| 12. Cleanup and docs | [x] |

## How to resume

Every phase is done. Read the plan, then the last session note. Layout: Go module at the root (`cmd/`, `internal/`, `web/`, `vendor/`), React app in `ui/`, speech service in `stt/`, shared TypeScript in `packages/`. Production is the host user unit `tmuxde.service` behind Caddy on 443. Development is `https://$LOCAL_DOMAIN:18443` from the `server-dev` and `ui` containers. Checks: `docker compose run --rm gotools go test ./...`, `docker compose run --rm tools pnpm test`, `pnpm typecheck`, `pnpm --filter @app/ui build`. Release: `docker build -f .docker/prod/tmuxde.Dockerfile --target binary --output type=local,dest=.docker/bin .` then `scripts/setup.sh --host-service` and `systemctl --user restart tmuxde`. Never touch the user's tmux server or `tmuxde_caddy-data`. Open items are listed at the end of the last session note and in the plan's deferred scope (file upload and download work, `openat2` hardening, multiple machines concept).

## Phase 0. Decisions and audit

- [x] 443 and TLS: stay with Caddy for now, binary phase deferred (2026-10-12)
- [x] Development topology: web container publishes `127.0.0.1:24100`, host binary proxies
- [x] Mode names: `hub` and `node`
- [x] Audit reachability with token login. Results in plan section Audit
- [x] Pin Go 1.27.2 and `coder/websocket v1.8.15`, `creack/pty v1.1.24`, `fsnotify v1.10.1`
- [x] Order: Go first, Vite last
- [x] Vendored modules
- [x] Branch: stay on `main`, no commits unless asked
- [x] Spikes moved: pty spike into phase 2, tmux server start into phase 10, Monaco under Vite into phase 8

## Phase 1. Go toolchain, vendoring, module skeleton

- [x] `.docker/dev/go.Dockerfile` from `golang:1.27.2-bookworm` pinned by digest, plus `tmux`, `git`
- [x] `gotools` service: read-only, no network, `apps/server` and `packages/protocol` ro, `.docker/bin` rw at `/out`, caches in `cache` volume subpaths `go-build` and `go-mod`, `GOPROXY=off`, `GOFLAGS=-mod=vendor`, `GOTOOLCHAIN=local`, `CGO_ENABLED=0`
- [x] `go-vendor` service: networked, `apps/server` rw, runs tidy and vendor, fails on module versions younger than five days
- [x] `init-volumes.sh` creates the two cache subpaths. `.docker/bin/` in `.gitignore` and `.dockerignore`
- [x] `apps/server` module, `vendor/` populated, `cmd/tmuxde` with `serve` and `version`
- [x] `internal/config` from env with validation and clear errors, mirrors relay `config.ts`
- [x] `internal/hub` and `internal/node` with the one interface, doc comment, no behaviour
- [x] `internal/protocol` scaffolding: envelope decode by `type`, per group registry files, field limit helpers, template group `auth`, `ping`, `pong`, `error`, `auth:success`, `auth:failure`, `server:info`
- [x] Fixture test harness: loads `packages/protocol/fixtures/{client,server}/*.json`, decode and round trip, every Go type has a fixture
- [x] Type list test: live `z.literal` names in TS minus dropped types equal Go registry
- [x] `go vet ./...`, `go test ./...` offline. `tmuxde version` and `serve` with `/health` run on host from `.docker/bin/`
- [x] CLAUDE.md commands section updated for Go checks

## Phase 2. Protocol contract and pty spike

Parallel work on disjoint files after phase 1.

- [x] Group sessions and windows: `session:*`, `window:*`, `layout:rotate` client and server types, fixtures, tests
- [x] Group panes, terminal, tmux, command: `terminal:*`, `pane:*`, `tmux:*`, `command:*` types, fixtures, tests
- [x] Group files and repository: `file:*` and repository request and response types, fixtures, tests
- [x] Group dictation: `dictation:*` types, fixtures, tests
- [x] Vitest in `packages/protocol`: every fixture parses, every live type has a fixture
- [x] pty spike as `internal/node/pty`: attach tmux on isolated socket, resize, UTF-8 carry across reads, bounded output queue with blocking read, ready and spawn error semantics as `pty-bridge.ts`. Tests with real tmux. Findings note in session notes

## Phase 3. HTTP, dev proxy and WebSocket lifecycle

Spec: [../go-single-binary-spec-ws-lifecycle.md](../go-single-binary-spec-ws-lifecycle.md)

- [x] `/health`, security headers, `/start` `/pair` `/j` redirects, 404
- [x] Dev proxy to web dev server including HMR. `web` service publishes `127.0.0.1:24100`
- [x] WebSocket upgrade on `/_relay`, origin check, 1 MiB frame cap
- [x] Connection caps, per message rate limit, liveness, idle reaper, close timeout
- [x] `auth` message, constant time token compare, auth throttle, `auth:success` with features, `server:info`
- [x] Access log
- [x] Forwarded address handling for Caddy only
- [x] Port tests: `auth`, `auth-throttle`, `ws-server`, `connection-manager`, `server.gate` (admit all), `access-log`, `user-agent`
- [x] CSP parity with Caddy: add `blob:` to media-src and frame-src, `object-src 'none'`, `base-uri`, `form-action`, `frame-ancestors 'none'` in `hub/edge` so file previews work without Caddy
- [x] `TestServeTCP` flaked once with "server did not stop" after 5 s. Make shutdown deterministic in the test
- [x] Remove unused `CodeUnknownMessage` from `hub/ws`

## Phase 4. Terminal

Spec: [../go-single-binary-spec-terminal.md](../go-single-binary-spec-terminal.md)

- [x] tmux CLI wrapper with socket option, default shell, timeout, output cap
- [x] Sessions: list, create, attach, detach, kill, rename, windows
- [x] Windows and panes: list, create, select, step, kill, rename, split, zoom by id, resize, swap, layout, rotate, capture
- [x] `tmux:prefix`, copy mode, scroll, scroll-to, scroll-state, exit copy mode
- [x] Attach epochs, pane and window ownership rule
- [x] Session monitor layout polling
- [x] Command messages: send, interrupt, eof, clear, suspend
- [x] `__tmuxde_` name filter and startup sweep
- [x] Every session name target uses exact match `=name` (attach, has-session, kill, rename, list-windows and the rest). tmux prefix and fnmatch matching must never pick another session
- [x] PTY Write blocks when tmux stops reading input. Cancelled by connection close. No userland buffer
- [x] Shared `protocol` helper for required slices so `session:list`, `pane:list`, `pane:changed`, `file:list` never encode `null`
- [x] Port tests: `tmux-manager`, `session-monitor`, terminal parts of `message-router`

## Phase 5. Files and repository

Spec: [../go-single-binary-spec-files-repo.md](../go-single-binary-spec-files-repo.md)

- [x] Path guards: realpath with parent fallback, deny list, allowed roots
- [x] `file:*` messages including chunked upload as it is today
- [x] Watchers with fsnotify
- [x] `/file` download with ranges, bearer, header sanitising
- [x] Repository request: context, list, read, status, diff, log, show with current limits
- [x] Port tests: `file-service`, `repository-service`, `repository-log`, file parts of `message-router`
- [x] Follow ups from phase 4: refuse session names with a leading `$` or containing `/` at create and rename (tmux resolves them as ids or client names); omit the shell command on new-session and new-window when `TMUX_DEFAULT_SHELL` is unset so tmux applies the user's default-shell and default-command; `protocol.TerminalSize` limits (1000x500) also bound list messages, parity with web Zod, note only

## Phase 6. Dictation

Spec: [../go-single-binary-spec-dictation.md](../go-single-binary-spec-dictation.md)

- [x] `stt` listens on unix socket in `~/.local/state/tmuxde/run/`, `network_mode: none`
- [x] Go client over unix socket, health probe intervals, feature flag
- [x] Session limits and queue cap as today
- [x] Port tests: `dictation`
- [x] Follow ups from phase 5: remove `internal/deps/deps.go` blank imports (all three modules are used now) and run `go-vendor` so `x/sys` loses its indirect marker; later hardening: `openat2` with `RESOLVE_NO_SYMLINKS` for file opens on Linux

## Phase 7. Parity against current web

- [x] Binary on spare loopback port, isolated tmux socket, proxying to Next dev server
- [x] Playwright flows: login, session list, attach, type, resize, panes, windows, scroll, copy mode, files, changes, history, Markdown preview, lock and unlock
- [x] Same flows on current stack, differences fixed
- [x] Mobile layout check
- [ ] `hub/ws` `TestShutdown` timed out once at its 5 s deadline in a full module run, then passed 10 of 10. Watch it, raise the deadline or make shutdown deterministic if it repeats
- [x] After cutover: change the `LOCAL_STT_SOCKET_DIR` mount source in `dev.yaml` and `prod.yaml` from `:-/nonexistent` to `:?Run scripts/setup.sh`, and drop the stt TCP listener, `speech` network and TCP healthcheck once the Node relay is gone (phase 12)

## Phase 8. Web to Vite SPA

- [x] Spike Monaco workers and workspace packages under Vite
- [x] `hub/edge` static asset exclusions for headers are Next specific (`/_next/`). Revisit for Vite paths (`/assets/`). Next entries removed, tests moved to `/assets/`
- [x] Add `vite`, `@vitejs/plugin-react`, `react-router` through dependency helper. Remove `next`, `@t3-oss/env-nextjs`
- [x] `index.html` with static metadata, viewport, icons, manifest. `public/robots.txt`
- [x] Layout routes with `createBrowserRouter`. `/login`, `/`, `/s/:sessionId`, catch all not found, root error boundary. `/start` and `/j` pages not ported
- [x] Swap `next/navigation`, `next/link`, `next/dynamic` usages
- [x] `VITE_RELAY_URL` replaces `NEXT_PUBLIC_RELAY_URL`. `import.meta.env.DEV` replaces `process.env.NODE_ENV`
- [x] Tailwind 4 build. Monaco workers. Shiki chunks. Fonts. `sw.js`, `offline.html`, `dictation-worklet.js`. Dictation not browser tested after the flip
- [x] Delete `proxy.ts`
- [x] Dev: `web` service runs Vite dev server on 24100. Binary proxies as before
- [x] Workspace wiring: `workspace.yaml` mounts, `init-volumes.sh`, root `vitest.config.ts`
- [x] Web tests, typecheck and build pass. Browser check of login, terminal, files, changes, history, Markdown, lock, mobile
- [x] Web follow up found in parity, both stacks: after renaming the session a browser is attached to, the web keeps the old name and never re-attaches. Fixed in phase 9: web follows the rename by session id, Go moves the attachment
- [x] `.docker/prod/web.Dockerfile` runner stage still copies the Next standalone output and no longer builds. Replace with a static server or drop it with the move to the binary (phase 12)
- [x] Next leftovers outside the web app: `.gitignore` and `.dockerignore` `.next` entries, `NEXT_TELEMETRY_DISABLED` in `tooling.yaml` and `prod.yaml`, the `/_next/webpack-hmr` path in `hub/edge` proxy tests. Harmless, phase 12

## Phase 9. Embed, binary build, second parity

- [x] Embedded static web, SPA fallback, cache rules, MIME table, not found page
- [x] `.docker/prod/tmuxde.Dockerfile` with web, go and `scratch` binary stages
- [x] Static binary, `CGO_ENABLED=0`, `-trimpath`, version stamped. Size recorded: 27.8 MB with the 19 MB web build embedded (Go side about 10 MB). Build took 22 s with cached layers
- [x] Playwright flows from phase 7 against the embedded build

## Phase 10. Host service and cutover behind Caddy

- [x] Spike: tmux server start outside the service cgroup. Sessions survive service restart, `sudo` works in a pane
- [x] Decide Caddy to binary transport (plan open decision 1): unix socket `~/.local/state/tmuxde/run/http.sock`, Caddy mounts the run dir read only and proxies with `reverse_proxy unix//run/tmuxde/http.sock`. Caddy sets `X-Forwarded-For`, the binary trusts it from unix socket peers
- [x] User unit, env file 0600, token migrated, linger enabled
- [x] `scripts/setup.sh --host-service` writes env file, unit, socket dir. Host tmux client copy stays until phase 12 (relay rollback)
- [x] Caddyfile change with user go ahead
- [x] User go ahead for cutover given 2026-10-12. `docker compose stop web relay`. Start unit. Verify login, terminal, files, dictation, phone
- [x] Soak: production ran from 2026-10-12 20:37 UTC through the phase 11 and 12 changes with the user working from the phone, two service restarts survived with sessions intact. Phone check passed. Node relay removed in phase 12, so the rollback is now a rebuild of the previous commit

## Phase 11. Development instance on 18443

Plan section: Development instance on 18443. Decided 2026-10-12: development runs in a self contained container with its own tmux server and the repository mounted read only. Only production runs on the host.

- [x] air pinned in `.docker/dev/go.Dockerfile`, `apps/server/.air.toml`, `server-dev` compose service (source binds, cache subpaths, `/repo` read only, run dir read write, tmpfs `/tmp` with exec, `network_mode: none`, hardened like `gotools`)
- [x] Caddy site block on 18443 routing `/_relay /file /health` to `http-dev.sock` and the rest to `web:24100`, port published on `LOCAL_BIND_IP`
- [x] Browser check on `https://$LOCAL_DOMAIN:18443`: login, create a session, `cd /repo`, Files, Changes and History on the checkout, file create and delete in the scratch dir, HMR on a web edit, Go edit rebuilds and restarts within seconds, container sessions survive the restart
- [x] Docs: `.docker/README.md` development section, CLAUDE.md commands and architecture

## Phase 12. Cleanup and docs

- [x] Move `stt.sock` into `run/stt/` so `server-dev` mounts only `run/stt` (read only) and `run/dev` (read write) and never the directory that holds the production `http.sock`. Production `STT_SOCKET` is `<run>/stt/stt.sock`, applied 2026-10-12
- [x] `web build missing` logs at WARN on a unix socket listener and stays ERROR on TCP
- [x] Repository restructure (2026-10-12): Go module at the root (`cmd/`, `internal/`, `web/`, `vendor/`, `go.mod`, `.air.toml`), React app in `ui/` (`@app/ui`, Compose service `ui`), `stt/`, `packages/ui-kit` (npm name `@repo/ui` kept). `apps/` gone
- [x] Remove relay service and Dockerfile, Node relay code, stt TCP listener and `speech` network, Next leftovers, the host tmux client copy and the host tmux mounts in setup and compose, `node-pty` in `allowBuilds`, tmux in the Node dev image, the prod web service and Dockerfile, `packages/logger`, the rollback patch
- [x] Remove Node relay after soak
- [x] Remove unreachable inherited web code per audit: sealed transport, route resolution and candidate race, session census, machine switcher and directory, device approval, local pairing, connect panel, bounce guard, descriptor storage, `device:*` and `auth:failure.code` in protocol (Zod, Go, fixtures), pairing, grants, semver, display label and version modules, pairing crypto (CPace, SAS, frames, device key, codes, key schedule), `@noble/curves`
- [x] Update CLAUDE.md architecture, commands and change rules (Go types, fixtures)
- [x] Rewrite `.docker/README.md` (setup, production, development, dictation, rollback), `packages/protocol/PROTOCOL.md` (server wording, pairing sections gone, step messages added), `stt/README.md` (socket only), README.md
- [x] `.docker/tests/runtime.py` checks ui and installer host IDs, `server-dev` run dir mounts (only `dev` and `stt`) and `stt` isolation

## Session notes

### 2026-10-12

- Started from a request for file upload and download in Files. Found host home is mounted read-only in the relay container and the current chunked upload truncates the target on the first chunk, so an interrupted upload over an existing file deletes it. Files work deferred until setup is stable.
- Considered relay only as a Node single executable behind Caddy, then web and relay merged in Node. Chose Go server with embedded React build. `stt` stays Node in Docker.
- Measured: relay 5,271 code lines and 5,322 test lines, protocol 1,258 lines and 87 message types, web 24,693 lines unchanged.
- Confirmed Node 26.11.1 has `--build-sea` (not used). Web has no route handlers, server actions or `next/headers`. Only `proxy.ts` needs Next server. Upstream `apps/cli/src/serve.ts` merged web and relay in one Node process with full Next and had to block Next's upgrade listener.
- Wrote plan and this backlog. No code changes yet.
- Follow up same day: dropped Next for Vite with React Router. Session link decision removed, `/s/<name>` stays. Plan gained a "Browser to server" section.
- Added multiple machines concept to the plan: `hub` and `node` roles in one binary, standalone default, node dials out to hub. Concept only.

### 2026-10-12, review and decisions

- Plan review written to `.agents/reviews/go-single-binary-plan-review.md`. Audit of inherited upstream code done: pairing, device approval, gate, sealed transport, clones, `/_sessions` all unreachable with token login. Only pane and window ownership check and `__tmuxde_` filter stay. Go gets 55 client and 30 server types.
- User decisions: Go first and Vite last. No TLS and no 443 in the binary for now, Caddy keeps them. Vendored Go modules. Stay on `main`, no branch, no commits unless asked. Start now.
- Pinned Go 1.27.2 (released 2026-10-02), `coder/websocket v1.8.15`, `creack/pty v1.1.24`, `fsnotify v1.10.1`. Separate `gotools` dev image instead of adding Go to the Node dev image, so the Node side and its fingerprint stay untouched.
- Plan rewritten with new order, audit section, interim cutover behind Caddy and deferred TLS section. Backlog phases renumbered.
- Four porting specs extracted from the relay by read-only scouts and saved next to the plan: `go-single-binary-spec-ws-lifecycle.md`, `-terminal.md`, `-files-repo.md`, `-dictation.md`. Each has constants, state machines, exact argv, test inventories and a Port notes section with traps the Go port must not copy (git timeout treated as success, upload truncates target on first chunk, delete follows symlinks, stale ready ack, missing `pane:zoom` ownership check).
- Bootstrap workflow launched: gotools and go-vendor services, module skeleton, protocol template, four protocol groups, pty spike, Vitest fixtures, review and fix.
- Bootstrap workflow done (9 agents, no errors). Verified by hand: `go vet` clean, `go test ./...` green, protocol Vitest 224 tests green. Binary builds to `.docker/bin/tmuxde`, about 10 MB static, runs on the host. Go code 4.0k lines plus 2.3k test lines. Fixtures: 55 client, 30 server, 37 invalid files with 66 entries.
- Review found 11 issues, all fixed: `AUTH_TOKEN` leaked into a tmux server started by the attach (now unset from the process env after config load, plus dropped in attach env, tested with a canary); tmux target prefix matching could attach `work` for `wor` or a hidden clone for `__tmuxde` (now `-t =name`, tested); `.docker/bin` created root owned by Docker on fresh clones (now tracked with `.gitkeep`, `create_host_path: false`); Vitest fixture harness blind to field drift (now round trips and checks top level keys); invalid fixtures added; HTML escaping off in `Encode`; `LogValue` redaction on terminal input, output, capture and dictation text; listen address must be loopback or private; go-vendor restores go.mod and go.sum when the age check fails; token leak test used a bad canary; literal emoji in test data replaced with escapes.
- pty bridge decisions accepted: tmux stderr goes to a capped pipe so a missing session is a spawn error with the tmux message, `-u` on the attach client, `TMUX` and `TMUX_PANE` stripped and `TERM` forced, no pause or resume (a consumer that stops draining is the pause), exit classified after the reader drains, `Close` marks detaching. Race tests need `-e CGO_ENABLED=1`.
- Follow ups carried into phase 4: `=name` for every session target, blocking Write, shared required slice helper. Not done: per group unit test files (negative cases are covered by the invalid fixtures instead), invalid fixtures for the two large max length checks (unit tested in Go).
- Phase 3 workflow done (7 agents, no errors). Verified by hand under `-race`: every package green, `docker compose config` ok. Packages: `hub/auth`, `hub/accesslog`, `hub/useragent`, `hub/edge`, `hub/conns`, `hub/ws`, `node/local` stub, serve wiring. Review found 3 issues, all fixed: broadcasts sent serially so one stalled browser delayed every later one (now parallel sends with a wait), unknown message types answered `UNKNOWN_MESSAGE` where the relay and web expect `INVALID_MESSAGE`, and the node received the full config including the token (now stripped).
- Sign offs recorded: throttle keys by host without port and unmaps IPv4 in IPv6; max entries cap strict; dictation stub follows relay parity (`start` UNAVAILABLE, `audio` and `stop` NOT_FOUND, `cancel` silent); access log label null as in the relay; forwarded address trusted only from unix socket or loopback peers, which settles open decision 1 on unix socket for the cutover; `IDLE_TIMEOUT_MINUTES` added to config; `ServeMux` path cleaning gives 301 on `//x` where Caddy passed it raw, accepted.
- Applied `dev.yaml` web change with `docker compose up -d web`: web publishes `127.0.0.1:24100` and joins `edge`. Binary rebuilt, 12 MB.
- Browser smoke test through the binary passed: `tmuxde serve` on `127.0.0.1:24200` with `TMUXDE_DEV_WEB_URL=http://127.0.0.1:24100`, login page served through the proxy with headers, token accepted, WebSocket authenticated, UI shows Connected, `session:list` answered `HANDLER_ERROR` "not implemented" from the stub node as expected. Access log wrote connected and disconnected lines. Two gotchas for the next run: the token is the bare hex line in `.docker/.env.token` (root `.env` wraps it in single quotes), and `playwright-cli` needs `open --browser=chromium` on this machine because the Chrome channel is not installed. Never use `pkill -f` with the binary path from a shell, it matches the shell itself. Use `pkill -x tmuxde`.
- Phase 4 workflow done (7 agents, no errors). Verified by hand under `-race`: every package green including `node/tmux` with real tmux and `e2e` through the hub. Host tmux sessions untouched. Packages: `node/tmux`, `node/monitor`, `node/local` (router), `e2e`. Follow ups landed: shared `RequiredSlice` helper, CSP parity with Caddy, `TestServeTCP` deterministic, dead constants removed.
- Review found 4 issues, all fixed with regression tests: unscoped `list-panes -s -t =name` resolved `=name` as a window in the current session first, so ownership checks could accept another session's panes (now `=name:`); a session named `$0` resolved to session id `$0` so kill or attach hit another session (leading `$` refused); empty id answered `INVALID_MESSAGE` where the relay answered `NOT_ATTACHED` or not found; sweep logged twice.
- Sign offs recorded: `--` before positional arguments in new-session, new-window, rename-session, rename-window (dash names failed on tmux 3.3a); session targets `=name`, window and pane targets `=name:`; names that are empty or contain `:` or `.` refused before tmux runs; pane ids must match `%N`, window ids `@N`; `CurrentWindowID` errors when the target does not resolve instead of falling back; a failed `-Z` probe is not cached; no server detection also matches "error connecting to" and "server exited unexpectedly"; `local.New(cfg, logger)`; `Node.Start` runs `tmux -V`, sweep and monitor before listen, `Node.Stop` after the relay shutdown because a monitor callback can block on a stalled browser queue; `-u` on the attach client. Default shell falls back to `/bin/sh` when `SHELL` is not absolute, follow up in phase 5.
- Browser smoke on an isolated socket passed: login, create session, typed `echo browser-marker-ok` visible in the browser and in `capture-pane`, split right gives two panes in tmux and the UI, clean shutdown with no attached clients. Only error line was the expected `not implemented: repo:request`.
- `node.go` gained `File`, `FileOpener`, `ErrDenied`, `ErrNotFile`, `ErrNotFound` for the `/file` download path in phase 5.
- Phase 5 workflow done (7 agents, no errors). Verified by hand under `-race`: every package green including `node/files`, `node/repo` with real git, `hub/filehttp` and the extended `e2e`. Host untouched. Follow ups landed: session names with a leading `$` or a `/` refused at create and rename, shell command omitted when `TMUX_DEFAULT_SHELL` is unset so tmux applies the user's default-shell and default-command, config default empty.
- Review found 5 issues, all fixed with regression tests: a rejected upload chunk let the next chunk start a new upload so a final chunk renamed only a tail over the original (now the upload is marked failed until its final chunk, refused after cleanup); `file:rename ~/.config ~/cfg` exposed `gh/hosts.yml` through the new name, relay had the same gap (rename refuses holders of denied roots and anything resolving to an allowed root); an allowed root configured through a symlink was denied by its own name (root name permitted); open without `O_NOFOLLOW` followed a symlink swapped in after the guard (now `O_NOFOLLOW` in files and repo); repo list sorted with its own folding that differed from file list for 92 runes (one shared `CompareNames`).
- Sign offs recorded: a symlink outside the roots that points inside is refused itself, paths below it resolve; dangling symlinks follow to their target for the guard; change throttle is leading plus one trailing per 50 ms; truncated reads drop a cut character; `Write` falls back to in place when a rename would lose hard links or ownership; `NewGuard` fails closed when a denied root cannot be resolved for a reason other than missing; deleting a directory that holds a denied root still deletes it (destructive op the user asked for, deny list is about reading); one unscoped `list-panes` serves both ownership and pane path for `repo:request`; guard failure at startup stops serve; non denied resolve errors reach handlers as short texts; base64 decoding matches Node exactly; unwatch and Close wait for the watcher; watcher cap 32 per connection; e2e client read limit 8 MiB.
- Browser smoke on an isolated socket passed for Files, Changes and History views against a temp repository under `~/.cache` (removed afterwards).
- Phase 6 workflow done (6 agents, no errors). Verified by hand: Go suite green under `-race` (one `TestShutdown` flake, passed 10 of 10 on rerun), stt tests 27 green, `docker compose config` ok. Packages: `hub/dictation` (bridge, probe, per connection session), ws dispatch wired, serve starts the probe. stt listens on `STT_SOCKET` next to TCP, stale socket handled, `LOCAL_STT_SOCKET_DIR` written by setup.py and mounted read-write at `/run/tmuxde`. `internal/deps` removed, `x/sys` direct in go.mod, vendor consistent.
- Review found 3 issues: compose edits would break stt until `.env` has `LOCAL_STT_SOCKET_DIR` (handled by hand: variable appended to `.env`, directory created 0750, stt recreated with `docker compose up -d stt`); a disconnect during the stt dial sent a false UNAVAILABLE and a warning (fixed with test); hook order comment wrong (fixed).
- Sign offs recorded: `Audio` and `Stop` return the NOT_FOUND reply for the caller to send; ending a dictation drops frames still queued for stt; EOF or reset maps to "Speech service closed the connection", other read errors to "Lost the speech service"; `Start` after `Close` is a no-op; `STT_SOCKET` limited to 107 bytes; `DecodePCM` reused for audio base64 instead of the node side helper; bridge goroutines not awaited at process exit.
- Phase 7 parity done (7 agents, no errors). Four flow groups in a headless browser against the Go binary (isolated tmux) and the current stack (host tmux, `parity-*` sessions only, all removed): sessions, windows and panes 6 of 7; scroll, copy mode and command controls 6 of 8; files, changes, history and Markdown 7 of 10 (two steps impossible on both stacks, the Files view has no editor or create, rename, delete controls); mobile, lock and sign out 7 of 8. Every mismatch had one root cause: new sessions and windows started in the binary's working directory because tmux falls back to the client's cwd when `-c` is absent, and the relay's container cwd did not exist on the host so tmux used HOME. Fixed: every tmux call runs with `Dir` set to HOME, tests added. Log noise after a rename (two ERROR lines per second) now Debug. Remaining differences are shared races (order of `[exited]` and `session:killed` after a kill, both servers random) or not reproducible (one dropped keystroke with two tabs, 20 of 20 clean in e2e).
- Current stack HTTPS in the headless browser needs `--config` with `ignoreHTTPSErrors`; service worker registration fails there as test noise.
- Phase 8 workflow done (5 agents, no errors). Web runs Vite 8.3.3 with React Router 8.4.0, client only. Route components live in `apps/web/src/routes/`, `router.tsx` builds the router, `index.html` holds metadata and a first paint theme script, `src/env.ts` exports `relayUrl` from `VITE_RELAY_URL`, Monaco workers come from `lib/monaco-workers.ts`, `next/dynamic` became `lib/lazy-component.tsx`. `next` and `@t3-oss/env-nextjs` removed through the helper. Dev container runs `vite --configLoader native` (the default loader writes under the read only node_modules). Dev scripts and the compose web command carry that flag. Vite cache lives in a cache volume subpath at `apps/web/.vite`. `allowedHosts` is `LOCAL_DOMAIN` only. Prod `web.Dockerfile` now serves the Vite build from a pinned Caddy image with SPA fallback and the three headers `proxy.ts` used to set. Verified by review: typecheck clean in 7 workspaces, 1468 tests green, build warning free, dist 19 MB (Monaco 3.8 MB, ts worker 6.9 MB), browser flows through Caddy and through the embedded binary.
- Real bugs fixed on the way: after a PIN unlock the device landed on `/login` because the lock store announced the master key before restoring the sealed token (regression test added); `next-themes` inline script logged a React error on every load; extension less paths under `/assets/` and `/fonts/` were served the SPA without security headers by the edge (now only paths with an extension skip headers); a missing list key in the Files view.
- Go static embed landed: `apps/server/web` embeds `dist` (placeholder `.gitkeep` keeps the build green without a web build), `hub/static` serves it with an explicit MIME table, immutable cache for `/assets/*`, no-cache for the shell files, ETag, SPA fallback and a 503 when the build is missing. `.docker/prod/tmuxde.Dockerfile` builds web, go and a scratch binary stage. Build: `docker build -f .docker/prod/tmuxde.Dockerfile --target binary --output type=local,dest=.docker/bin .`
- Left for phase 12: `.next` entries in `.gitignore` and `.dockerignore`, `connect-panel.tsx` unreachable, em dashes in `sw.js` comments, old cache volume subpaths `web-dev`, `web-build`, `web-dist`. The flip agent once ran `dependencies.py --help` by mistake, which triggered a sync; recovered with `up -d --no-build --wait web relay`.
- Phase 9 workflow done (6 agents, no errors). Production binary built with the Dockerfile, 27.8 MB, served the embedded site on loopback with isolated tmux. Three browser flow groups: terminal, windows, panes and scroll 7 of 7; files, Markdown, changes and history 6 of 7; mobile, lock, routes and fonts 6 of 6. Console had zero messages throughout, serve log zero errors and warnings, service worker activated, fonts and chunks all 200. Every problem found was web client behaviour, present with the Node relay too: the terminal did not follow a session rename; killing the active session left a stale terminal, an attach overlay and a toast, and the last session key kept the dead name; the attach replay drew a staircase because the capture has bare LF; the session row window count lagged; focus went to body after the kill dialog; a desktop click did not leave copy mode; the Files view stayed on "No session attached" after a layout switch; erase left the last session key.
- Fix agent changed web and Go: web follows a rename by session id on every `session:list` (`lib/session-lifecycle.ts`), killed and exited sessions are forgotten and the last session key cleared, `SESSION_NOT_FOUND` for the active session drops it and the `NOT_ATTACHED` replies in the next 3 s are not shown, focus returns to the terminal after a confirmed kill, a plain desktop click leaves copy mode, repo context is requested again after every `session:attached`, erase clears the last session key. Go: attach replay turns bare LF into CRLF, the router moves attached connections to the new name on rename, the monitor reports a rename by id instead of exit plus create and pushes `session:list` when a name, id, window count or attached flag changes. Behaviour change to know: `session:exited` for the attached session now clears the active session in the web, including a `prefix d` detach. Verified by hand after the fixes: typecheck clean, 1491 tests, web build, Go race suite green. Browser re-check against a fresh binary pending at the time of this note.
- Browser re-check on a fresh production build passed all five: rename followed within 2 s with the URL on `/s/rc-b` and no spurious exit, kill of the active session gave the empty state with the last session key cleared and no toast also after reload, replay aligned in a second tab, window count 2 within 1 s, Files view kept its tree across a 390 to 1280 layout switch. Console empty, serve log clean.
- Node relay keeps its old behaviour (raw LF replay, rename as exit plus create, no `session:list` push). The web handles both.
- Phase 10 prep workflow done (5 agents, no errors). tmux launcher: when no server answers, `new-session` runs through `systemd-run --user --scope --collect --expand-environment=no -- env -u INVOCATION_ID tmux ...` so the server lands in `tmuxde-tmux-<hex>.scope` outside the unit; `tmux -N` probes first so a running server is never wrapped; unit variables and tmuxde settings are stripped from the server env; `TMUXDE_TMUX_LAUNCHER=auto|systemd-run|none`. Proven on the host: a session created through the service survived `systemctl --user restart` and `stop`, pane env clean, NoNewPrivs 0. `scripts/setup.sh --host-service` installs binary (keeps `.previous`), env file 0600, unit from `.docker/host/tmuxde.service` with the linuxbrew and sbin PATH, `UMask=0002` so Caddy (root in the container, `group_add` host gid) can connect to `http.sock`. Review fixed 7 findings, among them: the socket Caddyfile was kept out of the working tree as `.docker/host/caddyfile-socket.patch` until cutover so a Caddy restart could not load it early; unit PATH gained the sbin dirs; attach runs with `-N`.
- CUTOVER DONE 2026-10-12 20:36 UTC. Binary `20261012-2035-aba3127` installed to `~/.local/bin/tmuxde`, `tmuxde.service` active, listening on `~/.local/state/tmuxde/run/http.sock`, dictation available. Caddy patch applied (`git apply .docker/host/caddyfile-socket.patch`), `docker compose up -d caddy` recreated Caddy with the run dir mount, `docker compose stop web relay`. Verified through `https://$LOCAL_DOMAIN`: production build served (assets, ETag from the binary, CSP from Caddy), `/start` 302, `/health` from the binary, browser login, real sessions listed, throwaway session `cutover-check` created, typed into and killed through the UI, journal 0 errors, access log records `lan` transport. `loginctl enable-linger` done. Running containers: caddy, stt. Stopped: web, relay.
- Rollback: `systemctl --user stop tmuxde.service`, `git apply -R .docker/host/caddyfile-socket.patch`, `docker compose up -d web relay caddy`. Delete the patch file once the socket Caddyfile is committed.
- Phase 11 workflow done (4 agents, no errors). `server-dev` compose service: gotools image with air v1.67.4 (released 2026-08-01), `apps/server/.air.toml`, air rebuilds and restarts the binary inside the container in about 1.5 s, own tmux 3.3a server on `/tmp/tmuxde-dev/tmux.sock`, repository read only at `/repo`, scratch under `/tmp/tmuxde-dev`, `network_mode: none`, run dir read only plus its own `run/dev` read write for `http-dev.sock`, `TMUXDE_TMUX_LAUNCHER=none`. Caddy site `https://$LOCAL_DOMAIN:18443`: `/_relay /health /file` to `unix//run/tmuxde/dev/http-dev.sock`, everything else to `web:24100`, port published on `LOCAL_BIND_IP`. Review fixed 4 findings: run dir was mounted read write (now read only plus the dev subdir), setup.py created the run dir only with dictation on (now always, plus `run/dev`), stale compose comments, CLAUDE.md URLs.
- Applied 2026-10-12 21:10 UTC: `run/dev` created, `docker compose up -d --wait web server-dev`, `docker compose up -d caddy` (recreated with 18443). Verified: 18443 serves the Vite index and the dev binary's health, 443 untouched (production uptime continued, `tmuxde.service` active). Running containers: caddy, stt, web, server-dev. Stopped: relay.
- Known gap recorded for phase 12: a read only mount does not block `connect`, so a dev pane could still reach the production socket through the shared run dir; moving `stt.sock` into its own subdir closes it.
- Warning for the user: `init-volumes.sh` changed, so the next `python3 .docker/dev/dependencies.py` run does a full sync and briefly restarts web and relay. `docker compose up` is not affected.
- Noted: `stt` dev container has been unhealthy for 17 hours with "Cannot find module '/workspace/apps/stt/src/index.ts'". Restart before dictation parity.

### 2026-10-12, Vite flip

- Next replaced by Vite 8.3.3 and React Router 8.4.0 in library mode. Route components moved from `src/app` to `src/routes/` (`root-layout`, `root-error`, `auth-layout`, `login`, `terminal-layout`, `terminal`, `session`, `not-found`). `src/router.tsx` wires them. `globals.css` moved to `src/globals.css`, `favicon.ico` to `public/`. Deleted `next.config.ts`, `proxy.ts`, `robots.ts` and the `/start` and `/j` pages. `src/env.ts` now exports `relayUrl` from `VITE_RELAY_URL`, checked with Zod.
- `next/dynamic` became `lib/lazy-component.tsx` (`React.lazy` in its own `Suspense`, same fallbacks). Monaco imports `@monaco-editor/react` statically and passes the skeleton as its `loading` prop, which removed an ineffective dynamic import warning. `lib/monaco-workers.ts` sets `MonacoEnvironment.getWorker` for editor, json, css, html and ts workers. Links and redirects to `/start` now go to `/login`.
- `/s/:sessionId` no longer calls `decodeURIComponent`. React Router decodes params, a second decode throws on `%`.
- First paint theme: next-themes renders its inline script for server rendering, which never runs in a client render and made React log an error. Root layout passes `scriptProps={{ type: "application/json" }}` to keep it inert, and `index.html` has a small inline script that sets the theme class before paint.
- Vite dev server sets `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy` (`server.headers`), which `proxy.ts` set under Next. Caddy still adds CSP and Permissions-Policy. Through the binary there is one copy of each header.
- Bug found in the browser check, fixed with a regression test: after a PIN unlock the device landed on `/login`. `unlockWithPin` and the passkey unlock announced the master key before restoring the sealed self-hosted token, so the terminal layout mounted, found no token and bounced. The token is now restored first.
- Compose: `web` runs `pnpm --filter @app/web exec vite --configLoader native --host 0.0.0.0 --port 24100`, env `VITE_RELAY_URL` and `LOCAL_DOMAIN`. `workspace.yaml` lost the `next.config.ts` bind and the `.next-dev`, `.next-build`, `.next` mounts. `init-volumes.sh` no longer creates `web-dev`, `web-build`, `web-dist` and removes the stale `next-env.d.ts` from the metadata dirs. Old dirs stay in the cache volume, unused. `tsconfig.json` includes only `src` and the config files.
- Checks: web typecheck clean, web tests 48 files and 695 tests green, build green with only the chunk size advisory (monaco 3.75 MB, index 873 kB). Chunk check: `index-*.js` imports only alert-store, preload-helper, rolldown-runtime and xterm. `dist` is 19 MB, the ts worker alone 6.9 MB. Go `vet` clean, `hub/...` and `cmd/...` green.
- Browser checks on the current stack through Caddy: login, session list, `check-vite-a` created and killed through the UI, typed output, Files, Markdown preview, text file, Changes, diff, History, commit view, deep link `/s/check-vite-a`, not found page, `/start` redirect, mobile layout with composer and copy mode (Monaco editor worker running), PIN lock and unlock, erase as sign out, login again. Console errors: only the service worker SSL error that the headless browser raises with an untrusted CA. Through the binary on `127.0.0.1:24200` with an isolated tmux socket: login, terminal, `[vite] connected` in the console, no errors or warnings, single security headers.
- Gotcha: `python3 .docker/dev/dependencies.py --help` is not a help flag. It ran a sync and stopped web and relay. Piping it into `head` killed it mid recreate and left stt with a temporary container name. Stack brought back with `docker compose up -d --no-build --wait web relay`, container renamed back.

### 2026-10-12, repository restructure

- Layout now: Go module `tmuxde` at the root (`cmd/tmuxde`, `internal/`, `web/` with `embed.go` and `dist/.gitkeep`, `vendor/`, `go.mod`, `go.sum`, `.air.toml`), React app in `ui/` (package `@app/ui`), speech service in `stt/`, shared components in `packages/ui-kit` (npm name `@repo/ui`, imports unchanged). Moves done with `git mv` (`-k` for `apps/web`, whose deleted Next files stay as unstaged deletions at their old paths). The untracked Go tree moved with plain `mv`.
- Removed: `apps/relay`, `packages/logger` (only the relay imported it), `.docker/prod/relay.Dockerfile`, `.docker/prod/web.Dockerfile`, relay service in dev and prod Compose, web service in prod Compose, `offline` network in prod Compose, `.docker/host/caddyfile-socket.patch` (its reverse routed to removed services; rollback is now `tmuxde.previous`).
- Compose: dev service `web` renamed `ui` (`pnpm --filter @app/ui exec vite`). Caddy 18443 upstream `ui:24100`. Dependency subpaths `stt`, `ui`, `packages-ui-kit`. Cache subpaths `ui-vite`, `ui-tooling-metadata`, `ui-dev-metadata`. Old subpaths (`apps-*`, `packages-ui`, `packages-logger`, `web-*`, `relay-dist`) stay in the volumes, unused.
- Go containers bind each part of the module (`cmd`, `internal`, `web`, `vendor`, `go.mod`, `go.sum`, `.air.toml` for gotools and server-dev) and `packages/protocol`, working dir `/workspace`. go-vendor binds `vendor`, `go.mod`, `go.sum` read write and runs `go mod vendor -o` into `/tmp`, then copies, because `go mod vendor` cannot remove a mount point. Probed: output identical to `vendor/`.
- Lockfile importers rewritten through `dependencies.py install --no-frozen-lockfile`: 0 packages added, 33 removed (pino, node-pty and their dependencies).
- Applied: old `web` container stopped with `docker stop` (orphan, held 127.0.0.1:24100), `up -d --wait ui stt server-dev`, `up -d --force-recreate caddy`. Orphan containers `tmuxde-web-1` and `tmuxde-relay-1` stay exited. Production `tmuxde.service` untouched (same PID and binary hash).
- Checks: typecheck clean in 5 workspaces, Vitest 69 files and 1171 tests, ui build, `go vet`, Go race suite, dev and prod `compose config`, release binary build, 443 and 18443 health, 18443 Vite index, browser login on 18443 with a session created, typed into and killed in the container tmux.

### 2026-10-12, cleanup and docs

- stt listens only on `STT_SOCKET`, now required. TCP listener, `STT_HOST`, `STT_PORT`, `EXPOSE` and the `speech` network are gone. Health checks in dev Compose and `stt.Dockerfile` use `http.get` over the socket. `stt` runs with `network_mode: none` in dev and prod. Tests moved to the socket listener, 25 green.
- Run directory split: `run/stt/stt.sock` (stt read write, `server-dev` read only), `run/dev/http-dev.sock` (`server-dev` read write), `run/http.sock` (production). Caddy keeps the whole run dir read only. `server-dev` no longer mounts the run dir itself. setup.py creates `run/stt` 0750 next to `run/dev` and checks all three socket paths for length. The `offline` network went from dev Compose, Caddy and ui are on `edge` only.
- Applied in this order: `install -d -m 0750 run/stt`, `python3 .docker/dev/dependencies.py` (rebuilt the Node dev image without tmux, resynced for the `node-pty` removal, recreated ui and stt), `up -d --wait server-dev`, `scripts/setup.sh --host-service` (env file changed, binary and unit unchanged), `systemctl --user restart tmuxde.service`, `up -d --wait caddy`. Journal: `dictation configured` with `run/stt/stt.sock`, availability true. The old `run/stt.sock` was gone after stt moved. Orphan containers `tmuxde-relay-1` and `tmuxde-web-1` removed with `docker rm`, volumes unchanged.
- Host tmux client copy removed from setup.py, `.docker/tmux-client` and `.docker/host-tmux` deleted. Setup no longer needs tmux and writes no `LOCAL_TMUX_*` or `STT_URL`. `--host-service` takes `TMUX_SOCKET` from the shell environment, default socket stays unset. Stale keys in an old `.env` are ignored. setup tests 13 green.
- `dependencies.py` restarts `ui` and `stt`, the two services that mount the dependency volume. Not `server-dev`: it mounts no dependencies and a stop would end its tmux sessions.
- Dead upstream web code removed per the audit, see the phase 12 list. Token login is the only path. `relay-url.ts` maps a configured `VITE_RELAY_URL` to its origin for `/file` (it used to keep the `/_relay` path). Lock screen erase copy no longer talks about paired machines. Kept: session key records in `session-store.ts`, because the lock store seals them, and the IndexedDB store names, so the database version never moves data.
- Vitest 51 files and 895 tests, typecheck clean in 5 workspaces, ui build (index chunk 695 kB), Go vet and race suite green, release binary built to `/tmp`.
- Browser on 18443: login, session created in `/repo` and typed into, Files and a Markdown preview, PIN enrolled, lock and unlock, Disconnect from Settings, then unlock lands on `/login`. Browser on 443: login lists the host sessions, nothing attached. Console only showed the known service worker SSL noise of the headless browser.


### 2026-10-12, phase 12 review fixes

- UI comments now point to Go code: `owned` in `internal/node/local/router.go`, `internal/node/tmux/scroll.go`, `internal/node/pty/bridge.go`. CLI, LAN QR, `connect-to-server` and `/pair` `/j` wording removed from `clipboard.ts`, `routes/terminal.tsx` and `sealKeysIfUnlocked`.
- `stt/README.md`: anchor is `#trust-the-local-ca`. Grant and read-only share wording dropped.
- Next leftovers: `/_next/webpack-hmr` in `hub/edge` proxy tests is `/hmr`. `sharp` left `allowBuilds`, resynced with a plain `dependencies.py` run. `"use client";` removed from 88 files. ui-kit `components.json` has `"rsc": false`.
- `LOCAL_STT_SOCKET_DIR` mount sources in `dev.yaml` and `prod.yaml` use `:?Run scripts/setup.sh`. Without the key both configs fail with that message.
- Removed orphan networks `tmuxde_speech` and `tmuxde_offline`. Removed stale subdirs from `tmuxde-dev-cache-v2` (`relay-dist`, `web-*`) and `tmuxde-dev-dependencies-v2` (`apps-*`, `packages-logger`, `packages-ui`). No volume removed.
- `.gitignore` ignores `__pycache__/`. Em dashes gone from `.gitignore` and `sw.js`.
- Checks: typecheck clean in 5 workspaces, 51 files and 895 tests, ui build clean, Go vet and race suite green, compose config dev and prod, `setup_test.py` 13 tests, `runtime.py`, Caddy validate, services healthy, `/health` 200 on 443 and 18443.
- Still open: `mtmux start` and `apps/cli` wording in `error-boundary.tsx`, `passkey-prf.ts`, `pwa-provider.tsx` and `packages/crypto/src/envelope.test.ts` comments.
