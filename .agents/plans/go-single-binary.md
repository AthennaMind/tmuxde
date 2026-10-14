# Go single binary

Replace the Node relay and the Next server with one Go binary, `tmuxde`, running on the host. It serves the React app, built by Vite, as embedded static files, speaks the existing WebSocket protocol and talks to host tmux directly. Speech to text stays a Node service in Docker. Compose and Caddy stay for good: Caddy owns TLS, the local CA, port 443 and the private network filter. The binary never does TLS (decided 2026-10-12).

Two instances of the binary run on the host, both behind the same Caddy and both sharing `stt`:

- Production on 443: the compiled binary with the embedded web build, installed as a systemd user service.
- Development on 18443: a self contained `server-dev` container runs air, which rebuilds and restarts the dev binary inside the container on every Go change. The container has its own tmux server (the image ships tmux and git), no host tmux and no home mount. The repository checkout is mounted read only for browsing and a writable scratch directory is there for file tests. Page and HMR requests go to the Vite dev server container. Fast iteration without touching the production instance or the user's sessions. Only production runs on the host.

Files upload and download is deferred until this setup is stable (decided 2026-10-12).

Review that shaped this version: [../reviews/go-single-binary-plan-review.md](../reviews/go-single-binary-plan-review.md).

Porting specs extracted from the relay, read before porting a phase: [go-single-binary-spec-ws-lifecycle.md](go-single-binary-spec-ws-lifecycle.md) (phase 3), [go-single-binary-spec-terminal.md](go-single-binary-spec-terminal.md) (phase 4), [go-single-binary-spec-files-repo.md](go-single-binary-spec-files-repo.md) (phase 5), [go-single-binary-spec-dictation.md](go-single-binary-spec-dictation.md) (phase 6).

## Why

- Host home stays read-only inside the relay container. Real file features need the real home.
- The relay reaches tmux through a copied client binary and a mounted socket. A host process uses tmux as is.
- Four containers and a Caddy front for one user on one machine. One process is easier to run, update and reason about.
- Go gives a static binary of roughly 20 to 30 MB, no glibc coupling, no native addon tricks (`creack/pty` is pure Go), cross compile by flag, `embed.FS` for the web build and native X.509 for TLS later.
- Node single executable was considered. It works, but carries a 130 MB file, an unpacked `node-pty` addon and still needs Caddy or a certificate library. Skipped.
- Next is only a build tool once Go serves the files. 14 files import it: `next/navigation`, `next/link`, `next/dynamic`, `next/server` (`proxy.ts`), `Metadata`. Static export would also force a change to `/s/<name>` links and add RSC payload files to serve. Vite with React Router removes both.

## End state

```
Browser ─https/wss:443───► Caddy (Docker, TLS, local CA, private range filter)
Browser ─https/wss:18443─►   │
                             ├─ 443:   everything ─► unix socket (run dir) ─► tmuxde (host, user unit tmuxde.service)
                             │                                                ├─ embedded React SPA (Vite build)
                             │                                                ├─ /_relay /health /file
                             │                                                ├─ tmux CLI and pty ─► host tmux server
                             │                                                ├─ files and git ─► real home, deny list
                             │                                                └─ ws ─► stt.sock
                             └─ 18443: /_relay /file /health ─► unix socket (run dir) ─► server-dev (Docker, air builds and runs tmuxde)
                                       everything else ─► web:24100 (Vite dev server, HMR)   ├─ own tmux server inside the container
                                                                                            ├─ /repo read only (this checkout), /tmp scratch rw
                                                                                            └─ ws ─► stt.sock (shared)
Docker: caddy, stt (profile dictation), web (Vite dev), server-dev (air), tools, gotools, go-vendor
Host:   tmuxde.service (production only)
```

- Same origin as today for production (`https://$LOCAL_DOMAIN`). Stored tokens, lock store, PWA installs and passkeys keep working. The dev origin `https://$LOCAL_DOMAIN:18443` has its own browser storage and its own login with the same token.
- Volume `tmuxde_caddy-data` holds the CA and is never pruned.
- The dev instance never touches the user's tmux server or home. Its sessions live and die with the container. Its state dir is `/tmp/tmuxde-dev` inside the container.
- The repository mount exposes the checkout to the dev file browser, including gitignored local files such as `.env`. Only a holder of the token sees it, on the private network. Accepted for development.

## Order

Go server first, Vite migration last (decided 2026-10-12). Go work is additive: new `apps/server`, new tooling service. The Vite migration breaks the running dev web container and the shared dependency volume for its whole duration, and the dev stack is in daily use. The binary's dev proxy is framework agnostic. It fronts the Next dev server during Go work and the Vite dev server after the migration with the same code. The current stack stays alive as parity reference while the Go server is built. Static embed happens after Vite.

## Scope

In: everything the current relay does on paths reachable with token login (see Audit), static web serving, Caddy routing for the dev instance, security headers, upstream route redirects, the host user service for production, cutover behind Caddy, the 18443 development container.

Out: TLS or 443 in the binary (never), files upload and download, multiple machine features (concept only), porting `stt` to Go, multi platform release automation.

Unchanged: web protocol layer (`ws-client.ts`, `transport.ts`, `use-websocket.ts`), stores, components, `packages/protocol`, `packages/ui`, `packages/crypto`, `apps/stt` apart from its listen socket.

## Audit of inherited upstream code

Done 2026-10-12. Standalone relay never installs any upstream hook: `armLocalPairing`, `setLocalPairingGate`, `setConnectionGate` and `askDeviceApproval` have no non-test callers. Live relay surface is three entry points: WebSocket on `/_relay`, `GET /file`, `GET /health`.

| Item | Reachable with token login | Verdict |
| --- | --- | --- |
| `/_pair/local`, `/_pair/session`, `/_pair/revoke` | No offer ever armed. Loopback only routes answer 403 through Caddy | Drop |
| `pair:*`, `tunnel:*`, `stream:*` messages (22 types) | Not in `ClientMessage` union | Drop |
| Scoped grants, `policy.ts` | Token always gets `FULL_GRANT`. Only pane and window ownership check (`policy.ts:238-257`) does work | Keep ownership rule as plain authorization |
| Device approval, connection gate, `device:*` messages | `connection-gate.ts:70` returns true with no gate. Relay never sends approval request | Drop |
| `SealedTransport` | Only built from tests. `ws-client.ts:129` always direct | Drop, web cleanup later |
| Read only clones | `session:attach` with `grant.readOnly`, never true. Name filter `__tmuxde_` and startup sweep still run | Keep filter and sweep, drop creation |
| `GET /_sessions` | Loopback plus token, no web caller | Drop |
| `auth` message | `{type, token}` in. `auth:success {serverVersion, capabilities, features}` then `server:info` out | Port |

Go gets 55 client and 30 server message types, `repo:request` and `repo:result` included. Dropped: `device:approve`, `device:paired`, `device:approval-request`, `device:approval-resolved` and all pairing types.

Bug noted on the way: `/_pair/local` 401 calls `recordAuthFailure` (`server.ts:160`) keyed on Caddy's container address. Five stale `/login#n=` loads lock token login for every client. Gone with the binary, which has no `/_pair` and sees real addresses.

## Decisions

Decided 2026-10-12:

- Go for the server.
- Web moves from Next to Vite with React Router in library mode (`createBrowserRouter`). Last step, see Order.
- TLS and 443 stay with Caddy for good (decided 2026-10-12, replaces the earlier "for now"). Binary serves plain HTTP over a unix socket behind Caddy, or loopback for ad hoc runs. No private range filter in the binary.
- `stt` stays Node in Docker.
- Protocol types are hand written in Go. Drift is caught by shared JSON fixtures tested by both TypeScript and Go (see Protocol contract). No code generator.
- Go dependencies vendored, `vendor/` in Git: `github.com/coder/websocket v1.8.15`, `github.com/creack/pty v1.1.24`, `github.com/fsnotify/fsnotify v1.10.1`. Everything else standard library. Toolchain Go 1.27.2 (released 2026-10-02) in a separate dev image from `golang:1.27.2-bookworm` pinned by digest, offline with `GOPROXY=off` and `GOFLAGS=-mod=vendor`. Vendoring runs in a one off networked service that also checks the five day release delay against `proxy.golang.org` `.info` dates.
- Development topology (updated 2026-10-12): Caddy serves `https://$LOCAL_DOMAIN:18443`, routes `/_relay`, `/file` and `/health` to the dev container's unix socket in the shared run dir and everything else to the Vite dev server container. The dev container `server-dev` is the Go tool image with air, which rebuilds and runs the binary inside the container, against a tmux server inside the container. It mounts this repository read only at `/repo` for browsing, a writable scratch dir, and the run dir for the stt socket and its own http socket. No host tmux, no home mount. Only production runs on the host. The published `127.0.0.1:24100` port stays for ad hoc host runs with `TMUXDE_DEV_WEB_URL`.
- Inherited upstream code: port and drop per Audit.
- Host service: systemd user unit with `loginctl enable-linger`. No capabilities needed without 443.
- Mode names for multiple machines: `hub` and `node`.
- Work happens on `main`, uncommitted until asked. Agents work in the main checkout on disjoint paths. Worktrees do not fit the Docker tooling: compose mounts the main checkout and the dependency volume is shared.

Open:

1. Decided 2026-10-12: unix socket. Interim cutover transport between Caddy and the host binary. Recommended: unix socket in `~/.local/state/tmuxde/run/` bind mounted into the Caddy container, `reverse_proxy unix//...`. No TCP exposure. Alternative: loopback TCP via host gateway. Decide in cutover phase.
2. tmux server start outside the service cgroup: `systemd-run --user` or a `tmux-server` user unit. Spike in host service phase.

## Multiple machines (concept only)

No features now. This section fixes names and boundaries so the single machine code does not block it later.

Goal: one browser UI over tmux on several machines.

Two roles in one binary, working names `hub` and `node`:

- `hub` faces the browser. Web files, browser auth, origin checks, throttle, access log, authorization rules, dictation, list of machines. TLS later.
- `node` faces one machine. tmux, pty, session monitor, files, repository, path guards. No browser port.
- `tmuxde` with no mode runs standalone: a hub and a local node in one process. Only this mode is built now.

Why not `agent` and `relay`: tmuxde exists to drive coding agents in panes, so "agent offline" in the UI would be ambiguous. `relay` already names today's tmux side process, which is the `node` role.

Link concept, not designed yet:

- A node dials out to its hub over TLS WebSocket. Nodes behind NAT work and open no inbound port.
- Enrollment with a one time join code. After that the hub pins the node's key.
- The existing message protocol runs per machine inside the link. The hub adds machine routing. The browser picks a machine.
- Dictation stays on the hub. Text reaches a pane as normal terminal input.

What this means for the code now:

- Hub code and node code live in separate packages. The hub reaches the node only through one interface: client messages in, server messages out. In process today. A remote node later implements the same interface over the link.
- Node code never reads HTTP requests, origins or tokens. The hub passes the connection's grant.
- The node checks path guards itself and never trusts the hub for paths.
- Output from node to hub goes through bounded queues, so backpressure behaves the same once the link is a network.
- The CLI uses subcommands from the start (`tmuxde serve`, `tmuxde version`), so `hub` and `node` modes can be added without breaking installed units.
- One interface, two packages. Nothing more until a second machine exists.

## Server layout

```
apps/server/
  go.mod  go.sum  vendor/
  cmd/tmuxde/main.go      subcommands: serve, version
  internal/
    config/     env parsing and validation, mirror of relay config.ts
    protocol/   message types, decode, field limits, mirror of packages/protocol
    hub/        browser side: http server, ws lifecycle, auth and throttle, router,
                authorization rules, access log, dictation client, headers, redirects
    node/       machine side: tmux CLI, pty bridge, session monitor, files, repo, path guards
    web/        dev proxy now, embedded dist with cache rules and MIME table after Vite
  web/dist/     embed target, filled by build, gitignored
```

Sub packages inside `hub/` and `node/` are fine (`node/tmux`, `node/pty`, `node/files`). The boundary that matters is the one between them.

## Behaviour that must carry over

Read the relay source and its comments before porting each module. They record fixes that are easy to lose.

- Attach epochs (`attachId`) so stale acks cannot corrupt client state.
- Pane zoom by id and wanted state, not toggle.
- PTY output backpressure. Pause reads while the socket queue is full.
- UTF-8 boundaries. `terminal:output` is a JSON string. Go reads bytes, so an incomplete trailing sequence must carry to the next read instead of becoming U+FFFD.
- Scroll and copy mode rules (`tmux:scroll`, `tmux:scroll-to`, `tmux:scroll-state`, `tmux:exit-copy-mode`).
- Pane and window ownership: messages that name a pane or window id are refused unless the id belongs to the attached session (`NOT_ATTACHED`, `PANE_NOT_FOUND`, `WINDOW_NOT_FOUND`).
- Sessions named `__tmuxde_*` hidden from every list and broadcast, refused on attach, killed at startup sweep.
- Path guards: realpath with parent fallback for new paths, deny list for `~/.tmuxde`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.kube` and the config dir, checked on every file and repository path.
- `/file` download: bearer header, deprecated `?token=` logged, `Content-Disposition` sanitising, range requests.
- Inbound frame cap 1 MiB, per message rate limit, connection caps, idle timeout, close handshake timeout.
- Auth throttle and connection caps keyed by client address. Behind Caddy the binary must read the forwarded address from Caddy only, never from a direct client.
- `auth:success.features` list, including `dictation` only while `stt` health passes.
- Security headers from `proxy.ts`: CSP, Permissions-Policy, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`. Caddy keeps its header block until it is removed.

## Protocol contract

- `packages/protocol/fixtures/client/<type>.json` and `fixtures/server/<type>.json`, one or more valid samples per message type, checked into Git. File name is the type with `:` replaced by `.`.
- Vitest: every fixture parses with `ClientMessage` or `ServerMessage`, and every live message type has a fixture.
- Go test: every fixture decodes into its Go type, re-encodes to equal JSON, and every Go message type has a fixture.
- Go test reads `type: z.literal("...")` names from `packages/protocol/src/*-messages.ts` and `repository.ts` and fails when a live type has no Go type or no handler. Replaces `policy.test.ts`.
- Invalid fixtures: `packages/protocol/fixtures/invalid/{client,server}/<name>.json`, entries `{field, message}` where `message` is a valid sample with one field broken. Vitest asserts `safeParse` fails on that field. Go asserts `Decode` returns an error naming that field. Every Zod constraint gets one entry.
- Vitest also asserts every sample parses back to itself (Zod strips unknown keys) and that sample 0 has exactly the schema's top level keys. Go asserts sample 0 sets every struct field and a later sample omits every optional one. Together these catch field drift in both directions.
- `PROTOCOL.md` stays the reference. Protocol changes now touch Zod, Go types, valid and invalid fixtures, both handlers and `PROTOCOL.md`.

## Browser to server

Unchanged from today. Only the server behind the origin changes.

```
1. GET https://<domain>/            Caddy forwards to tmuxde, which serves index.html and assets
2. Login stores token               localStorage, encrypted under local lock
3. WebSocket wss://<domain>/_relay  URL from window.location (lib/relay-url.ts)
4. -> auth {token}                  <- auth:success {features, capabilities, defaultPath}
5. JSON text frames both ways       one object per frame, Zod on web, Go structs on server
6. GET /file?path=...               Authorization: Bearer <token>, images and downloads
```

Inside the binary: `/_relay` upgrade, origin check, caps, auth, then router with authorization rules, then node: tmux, pty, files, repo, or hub dictation.

Dev mode keeps one origin. `tmuxde serve` with a dev web URL handles `/_relay`, `/file` and `/health` itself and proxies everything else, HMR included, to the web dev server. Next now, Vite later. No CORS in either mode.

## Web changes

Last phase before embed. Lands as one focused change.

- Vite with `@vitejs/plugin-react` and `react-router` through dependency helper. Remove `next`, `@t3-oss/env-nextjs`. New dependencies follow the five day release delay.
- Routes: `(auth)` and `(terminal)` groups become layout routes with `createBrowserRouter`. `/login`, `/`, `/s/:sessionId` keep their URLs. `/start`, `/pair`, `/j` are not ported. The server redirects them to `/login`.
- Swap `next/navigation` for `useNavigate` and `useParams`, `next/link` for router `Link`, `next/dynamic` for `React.lazy` with Suspense.
- `Metadata` and `Viewport` exports become static tags in `index.html`. `robots.ts` becomes `public/robots.txt`.
- `not-found.tsx` becomes a catch all route. `global-error.tsx` becomes a root error boundary.
- Delete `src/proxy.ts`. Its headers move to the binary.
- Drop `@t3-oss/env-nextjs`. `NEXT_PUBLIC_RELAY_URL` becomes `VITE_RELAY_URL` and stays empty. `process.env.NODE_ENV` checks become `import.meta.env.DEV`.
- Tailwind 4 through `@tailwindcss/vite` or the existing PostCSS config.
- Monaco workers need explicit Vite setup. Verify editor, diff and copy mode overlay.
- Workspace packages export TS sources, Vite imports them directly.
- `next-themes` stays, it does not depend on Next.
- Vitest config for web moves onto the Vite config where useful.
- Server falls back to `index.html` for unknown paths without a file extension, so deep links load the SPA.
- Embed with `//go:embed dist`.
- Cache rules: `/assets/*` immutable for a year. HTML, `sw.js` and `manifest.json` no-cache.
- Explicit MIME table for `.js`, `.css`, `.woff2`, `.wasm`, `.json`, `.webmanifest`, `.svg`.

## Host service

- Binary at `~/.local/bin/tmuxde`. Config at `~/.config/tmuxde/tmuxde.env`, mode 0600: listen address, `AUTH_TOKEN`, `ALLOWED_PATHS`, tmux socket, `stt` socket path. Token migrates from `.docker/.env.token`.
- User unit `~/.config/systemd/user/tmuxde.service`, `Restart=on-failure`, `loginctl enable-linger` so it survives logout. No capabilities. No `PrivateTmp`, the tmux socket lives in `/tmp/tmux-<uid>`.
- The binary never becomes parent of the tmux server. A server it forks would sit in the unit's cgroup, die on every restart and take all sessions with it, and would pass unit restrictions to every shell. When no server runs, start one through the user manager (`systemd-run --user` or a `tmux-server` user unit). Spike decides which.
- Socket dir `~/.local/state/tmuxde/run/`, mode 0750, holds `stt.sock` and, if chosen, `http.sock` for Caddy. `stt` listens there with `network_mode: none`.

## Build

Development, all in Docker:

```sh
docker compose run --rm gotools go vet ./...
docker compose run --rm gotools go test ./...
docker compose run --rm gotools go build -trimpath -o /out/tmuxde ./cmd/tmuxde   # lands in .docker/bin/
docker compose run --rm go-vendor                                                 # networked, after go.mod changes
```

- Go module name is `tmuxde`. Packages `tmuxde/internal/...`.
- `gotools`: image from `.docker/dev/go.Dockerfile` (`golang:1.27.2-bookworm` pinned by digest, plus `tmux` and `git`). Read-only, `cap_drop ALL`, `network_mode: none`, `apps/server` and `packages/protocol` bind mounted read-only, `.docker/bin` writable at `/out`, `GOCACHE` and `GOMODCACHE` in the `cache` volume. `GOPROXY=off`, `GOTOOLCHAIN=local`, `GOFLAGS=-mod=vendor`, `CGO_ENABLED=0`.
- `go-vendor`: same image with network, `apps/server` writable. Runs `go mod tidy`, `go mod vendor`, then fails if any required module version is younger than five days per `proxy.golang.org/<mod>/@v/<ver>.info`.
- `.docker/bin/` holds build output. Tracked as an empty directory through `.gitkeep` so Docker never creates it as root. `.gitignore` has `.docker/bin/*` plus `!.docker/bin/.gitkeep`. `.dockerignore` excludes it. The `/out` mount uses `create_host_path: false`.
- Race detector needs CGO: `docker compose run --rm -e CGO_ENABLED=1 gotools go test -race ./...`.
- Prod image later: `.docker/prod/tmuxde.Dockerfile` with web stage (pnpm, Vite build), go stage (`CGO_ENABLED=0 go build -trimpath`, version via `-ldflags`), `FROM scratch AS binary`, output with `--output type=local,dest=.docker/bin`.

## Testing

- Port relay Vitest suites to Go tests module by module. Test cases are the spec. Port them before or with the code.
- tmux tests run a real tmux on an isolated socket (`-S` in a temp dir), as `tmux-manager.test.ts` does today. Never the user's server.
- Contract fixtures as above.
- Playwright against the binary on a spare loopback port (`http://127.0.0.1:<port>` is a secure context) with an isolated tmux socket. Same flows on the current stack for comparison.
- Phone check happens through Caddy at cutover. CA unchanged, nothing to trust again.

## Cutover, interim

1. Build binary, install to `~/.local/bin`, write env file and user unit, enable linger.
2. Caddyfile: proxy everything to the host binary over the chosen transport. `docker compose stop web relay`. Caddy stays. No `down -v`.
3. Start `tmuxde.service`. Verify login, terminal, files, changes, history, dictation, phone.
4. Rollback: stop unit, restore Caddyfile, `docker compose up -d`. Host tmux sessions survive both ways.

Cutover needs explicit user go ahead. It drops browser connections briefly.

## Development instance on 18443

- Caddy: second site block `https://{$LOCAL_DOMAIN}:18443`, same `tls internal`, same private range filter, redirects and header block (CSP `connect-src` adds `wss://{$LOCAL_DOMAIN}:18443`), routes `/_relay /file /health` to `unix//run/tmuxde/http-dev.sock` and everything else to `web:24100`. Caddy publishes `${LOCAL_BIND_IP}:18443:18443`.
- `server-dev` compose service: the Go tool image with air (pinned version installed at image build, five day delay respected by hand). Runs `air` with `apps/server/.air.toml`: `cmd` builds `/tmp/tmuxde-dev/bin/tmuxde` from the read only source mount at `/workspace/apps/server`, `bin` runs it with `serve`, `tmp_dir` under `/tmp`. Mounts: the source binds of `gotools`, the `cache` volume subpaths for `GOCACHE`, this repository read only at `/repo`, `LOCAL_STT_SOCKET_DIR` read write at `/run/tmuxde`. `/tmp` is a tmpfs with exec and holds `HOME=/tmp/tmuxde-dev`, the scratch dir `/tmp/tmuxde-dev/scratch`, the state dir and the tmux socket. Environment: `AUTH_TOKEN`, `ALLOWED_PATHS=/repo,/tmp/tmuxde-dev/scratch`, `HOME=/tmp/tmuxde-dev`, `TMUX_SOCKET=/tmp/tmuxde-dev/tmux.sock`, `TMUX_DEFAULT_SHELL=/bin/bash`, `TMUXDE_CONFIG_DIR=/tmp/tmuxde-dev/state`, `TMUXDE_LISTEN=unix:/run/tmuxde/http-dev.sock`, `CORS_ORIGINS=https://<domain>:18443`, `STT_SOCKET=/run/tmuxde/stt.sock`. `network_mode: none`, it reaches stt and Caddy through the socket dir. Same hardening as `gotools`.
- The tmux server inside the container starts on the first session (launcher runs plain, no systemd). Sessions start in `HOME`; `cd /repo` to browse the checkout. Git views work on `/repo` because the repository service sets `GIT_OPTIONAL_LOCKS=0` and only reads.
- Health: Caddy does not depend on it. The healthcheck runs `curl --unix-socket /run/tmuxde/http-dev.sock http://tmuxde/health`.
- `docker compose up -d` starts caddy, stt, web and server-dev. The dev loop is: edit Go, air rebuilds and restarts the dev binary in about a second, browser reconnects, its container sessions survive because the tmux server is a separate process in the container. Edit web, Vite HMR updates the page.
- Production and development share only stt and Caddy. Different port, socket, tmux server, files and state.

## Risks

- Behaviour parity. Mitigation: ported tests first, side by side runs with the current stack, soak period before deleting Node relay.
- Protocol drift between Zod and Go. Mitigation: fixtures both ways plus the type list test.
- Dev stack in daily use. Mitigation: Go work is additive, Vite migration last and short, cutover reversible.
- Upstream relay fixes no longer apply by cherry pick. Accepted. Web cherry picks still work, merge base exists.
- Forwarded address trust. Behind Caddy the binary must only honour `X-Forwarded-For` from Caddy. Unix socket transport removes the question.
