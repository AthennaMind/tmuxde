# tmuxde

## What this is

tmuxde (Tmux Development Environment) is a self-hosted IDE with tmux as its backend. tmux owns sessions, windows, panes and their processes. tmuxde is the IDE around it, in browser on desktop or phone, served on private network only. Main use case is driving long-running coding agents (Claude Code, Codex) and shells. Closing browser, locking device, restarting the server or rebuilding containers never kills sessions.

Selected pane is the focus. IDE surfaces take their context from it: folder, repository, branch, changes. Switching panes or `cd` in the pane moves the IDE with it. New features should follow this model. Current surfaces (session tree, files, changes, diffs, commit history, git graph, mobile terminal controls) are early and expected to change.

Repository is [AthennaMind/tmuxde](https://github.com/AthennaMind/tmuxde). It is a fork of [mtmux/mtmux](https://github.com/mtmux/mtmux). Upstream ships `mtmux` npm CLI, QR and code pairing, hosted broker, sealed tunnel, accounts and billing. This fork removed all of that and the Node relay. What remains is the React web client and a Go server, single binary `tmuxde`. Optional dictation runs a second Go binary, `tmuxde-stt`, in its own container. Production runs the binary as host user unit behind Caddy with local CA. Development runs in Docker Compose. Sign-in uses token from `.docker/.env.token`. Setup and operation guide is [.docker/README.md](.docker/README.md).

## Architecture

```
Production, port 443:
Browser ─https/wss─► Caddy (Docker) ─► run/http.sock ─► tmuxde, host user unit tmuxde.service
                                                         ├─ embedded ui build (web/dist)
                                                         ├─ host tmux server, host files and git
                                                         └─ run/stt/stt.sock ─► stt (Docker, optional)

Development, port 18443:
Browser ─https/wss─► Caddy ─┬─► run/dev/http-dev.sock  /_relay /file /health ─► server-dev (Docker)
                            └─► ui:24100 everything else ─► Vite dev server with HMR (Docker)
server-dev: air rebuilds and runs tmuxde on Go change. Own tmux server, /repo read only, scratch dir, run/stt/stt.sock
```

`run` is the run directory `LOCAL_STT_SOCKET_DIR`, default `~/.local/state/tmuxde/run`, mode 0750. Caddy mounts it read only. `stt` mounts only `run/stt`. `server-dev` mounts only `run/dev` (read write) and `run/stt` (read only), never `http.sock`.

- `.docker/Caddyfile`: site on 443 sends every request to `unix//run/tmuxde/http.sock`. Site on 18443 routes `/_relay`, `/health` and `/file` to `unix//run/tmuxde/dev/http-dev.sock` and everything else to `ui:24100`. Both reject non-private IPs, set CSP and permissions policy, and redirect upstream code entry routes (`/start`, `/pair`, `/j`) to `/login`. Any Caddy restart loads the file on disk.
- Server (`cmd/tmuxde`, `internal`, `web`): Go module `tmuxde` at the repository root. `cmd/tmuxde` is the binary with subcommands `serve` and `version`. `serve` runs one hub and one local node in one process. `internal/hub` faces the browser: `edge` (routes, security headers, redirects, dev proxy), `ws` (WebSocket lifecycle and origin check on `/_relay`), `auth` (token and failure throttle), `conns`, `static` (serves the embedded ui build), `filehttp` (`GET /file`), `dictation` (bridge to `stt.sock`), `accesslog`, `useragent`. `internal/node` drives this machine: `local` routes every client message and applies the pane and window ownership rule, `tmux` wraps tmux CLI, `pty` attaches tmux clients, `monitor` polls session and layout changes, `files` and `repo` enforce `ALLOWED_PATHS` and the credential deny list. `repo` also owns the repository watcher behind `repo:watch`: one fsnotify instance per connection and root over the git directory, `refs` and the worktree minus ignored folders, coalesced into `repo:changed` pushes that the UI turns into silent reloads. `internal/protocol` holds the Go message types. `internal/config` reads env. `web/` embeds `web/dist`, the ui build. `vendor/` holds Go modules, builds run offline. `cmd/tmuxde-stt` and `internal/stt` are the speech service `tmuxde-stt` in the same module, see Dictation.
- Protocol (`src/ui/src/protocol`, imported as `@/protocol`): Zod discriminated unions `ClientMessage` and `ServerMessage`, one JSON object per WebSocket message (`codec.ts`). `fixtures/` holds a sample for every wire type plus invalid cases. Vitest (`fixtures.test.ts`) and the Go contract test (`internal/protocol/contract_test.go`) both check them, and the Go test requires the Go registries to match the TypeScript types exactly.
- UI (`src/ui/src`, package `tmuxde-ui`): client only React app built by Vite. `router.tsx` holds React Router routes (`createBrowserRouter`): `/login` under the entry layout, `/` and `/s/:sessionId` under the terminal layout, catch all not found. Route components live in `routes/`. Static metadata lives in `index.html`. Monaco workers come from `lib/monaco-workers.ts`. `lib/ws-client.ts` owns reconnect, backoff and message queue over `lib/transport.ts` (plain WebSocket). `hooks/use-websocket.ts` applies server messages to Zustand stores in `stores/`. Terminal uses xterm.js (`lib/xterm-factory.ts`). Mobile controls live in `components/mobile`. Repository viewer lives in `components/files` with bundled Shiki highlighting, together with commit tabs, the commit file filter and the git graph tab (`graph-layout.ts` is the pure lane layout).
- Dictation (optional): `stt` runs the Go binary `tmuxde-stt` (`cmd/tmuxde-stt`, `internal/stt`). It decodes Parakeet TDT through a cgo binding to the sherpa-onnx C API (`internal/stt/sherpa`, build tag `sherpa`), one decode per utterance found by Silero VAD (`segmenter.go`). Only `.docker/prod/stt.Dockerfile` builds it with cgo, and both stacks use that image. Every other build gets a stub that refuses to serve, so `go vet` and `go test` need no C headers. It listens only on `STT_SOCKET`, has no TCP listener and no network. Server `internal/hub/dictation` forwards `dictation:*` audio to it and advertises `dictation` in features only while its probe passes. UI `lib/dictation.ts` records through `public/dictation-worklet.js`, then types into the focused field or pastes into the selected pane, never pressing Enter. Off unless `scripts/setup.sh --dictation`.
- Local lock: `lib/lock-store.ts`, `lib/lock-controller.ts` and `components/lock` keep the stored token encrypted under in-memory master key, unlocked by PIN or passkey PRF. Locking drops key, disconnects and clears stores. It never touches tmux. `lib/session-store.ts` owns the IndexedDB database. Its session key records are upstream pairing leftovers that the lock still seals if a browser holds any.
- Hidden sessions: names starting with `__tmuxde_` were read only clones of the old relay. The server never creates them, hides them from every session list and sweeps them at start.

Token login is the only sign-in path. Pairing, device approval, the sealed tunnel and the machine switcher were removed from UI, protocol and crypto.

## Repository map

- `cmd/tmuxde`, `internal`, `web`: Go server `tmuxde`. Module `tmuxde`, `go.mod`, `go.sum`, `vendor/` and `.air.toml` at the repository root.
- `cmd/tmuxde-stt`, `internal/stt`: optional local speech to text for dictation, Go binary `tmuxde-stt`. Own container built from `.docker/prod/stt.Dockerfile`, reached by the Go servers only. Guide in `internal/stt/README.md`.
- `src/ui`: React app, Vite and React Router. One pnpm package with `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (settings only) and configs. Terminal client, mobile controls, local device lock and repository viewer.
- `src/ui/src/protocol`: validated client/server messages, shared types, wire fixtures and `PROTOCOL.md`, the maintained reference for every message type.
- `src/ui/src/crypto`: envelope sealing and PIN key derivation for the device lock.
- `src/ui/src/components/ui`, `hooks`, `providers`, `lib`: shared UI components, theme and helpers. Tokens and Tailwind theme live in `src/ui/src/globals.css`. Imports use the `@/` alias for `src/ui/src`.
- `Makefile`, `.golangci.yml`: Go checks (`vet`, `lint`, `test`, `race`, `check`) through `gotools`, and golangci-lint config.
- `.docker`: Compose files (`compose/dev.yaml`, `prod.yaml`, `tooling.yaml`, `workspace.yaml`), dev images, prod `tmuxde.Dockerfile` and `stt.Dockerfile`, host unit template, Caddyfile and `README.md`.
- `scripts/setup.sh`: writes `.env`, token and run directory. `--host-service` installs the binary as user unit.
- `.agents`: UI review skills (`better-*`, `interface-review`), tracked. Plans, backlogs and reviews also live here but are gitignored.

## Commands

All Node and Go tooling runs in Docker. Run from repository root.

```sh
scripts/setup.sh                                  # first run: .env, token, upload folder, run directory
scripts/setup.sh --dictation                      # also enable speech to text (downloads models once)
scripts/setup.sh --host-service                   # install .docker/bin/tmuxde as systemd user unit, enabled, not started. --print is a dry run
scripts/setup.sh --host-service --uninstall       # stop, disable, remove unit. Keeps settings and binary unless --purge
docker build -f .docker/prod/tmuxde.Dockerfile --target binary --output type=local,dest=.docker/bin .   # release binary with embedded ui build
systemctl --user restart tmuxde.service           # production picks up a new binary or env file
journalctl --user -u tmuxde -f                    # production log
docker compose up -d --build --wait               # dev stack: caddy, ui, server-dev, stt with dictation
docker compose up -d --build stt                  # rebuild and restart the speech image after a change in internal/stt or cmd/tmuxde-stt
docker build -f .docker/prod/stt.Dockerfile -t tmuxde-stt:local .   # speech image alone, compiles the cgo binding
docker compose logs -f server-dev                 # air rebuilds and restarts the dev binary on every Go change
docker compose run --rm tools pnpm test           # all Vitest projects
docker compose run --rm tools pnpm test src/lib/relay-url.test.ts   # single file, path relative to src/ui
docker compose run --rm tools pnpm typecheck
docker compose run --rm tools pnpm build
make check                                        # go vet, golangci-lint and go test in gotools. make lists targets
make lint                                         # golangci-lint only, config in .golangci.yml
docker compose run --rm gotools go vet ./...      # gotools works in /workspace, the module root
docker compose run --rm gotools go test ./...
docker compose run --rm -e CGO_ENABLED=1 gotools go test -race ./...   # race detector needs CGO
docker compose run --rm gotools go build -trimpath -o /out/tmuxde ./cmd/tmuxde   # writes .docker/bin/tmuxde without the ui build
docker compose run --rm go-vendor                 # after go.mod change. Networked, five day release check
python3 .docker/dev/dependencies.py mutate add <pkg>
python3 -B .docker/dev/setup_test.py              # setup.py tests
python3 .docker/tests/runtime.py                  # dev user IDs, server-dev and stt isolation
docker compose down                               # keeps volumes and host tmux sessions. Also stops Caddy, so production on 443 goes offline, and ends server-dev sessions
```

Production URL is `https://$LOCAL_DOMAIN`, served by `tmuxde.service` through Caddy. Development URL is `https://$LOCAL_DOMAIN:18443`. Both bind on `LOCAL_BIND_IP`. Domain and address live in root `.env`, default to `localhost` and `127.0.0.1`, and survive `scripts/setup.sh` reruns. Production Compose config is `.docker/compose/prod.yaml` (Caddy and stt only).

Machine-specific notes (real domain, addresses, device trust) live in gitignored `AGENTS.local.md`. `CLAUDE.local.md` links to it. Read it when present. Never copy its values into tracked files.

## Runtime

Caddy exposes internal HTTPS on port 443, and 18443 in development. The binary listens on unix sockets only and never does TLS. `ui` publishes `127.0.0.1:24100` for a host binary run by hand with `TMUXDE_DEV_WEB_URL`. `stt` and `server-dev` have no network. Preserve Caddy volumes across deployments. Host tmux sessions and upload storage must survive container rebuilds and service restarts.

Browser assets must be local. No analytics exporters, hosted accounts, cloud dictation or automatic public service requests. Framework telemetry stays disabled during development, builds and runtime. User commands in host tmux retain host network behavior.

## Changes

Protocol changes require Zod schemas, Go types with their registry entry in `internal/protocol/client` or `internal/protocol/server`, fixtures in `src/ui/src/protocol/fixtures` (invalid cases too), both handlers, tests and updates to `src/ui/src/protocol/PROTOCOL.md`. Both handlers means Go router in `internal/node/local` and UI `src/ui/src/hooks/use-websocket.ts`. File access must use path guards in `internal/node/files`. Session operations go through `internal/node/tmux`. Preserve authentication, origin checks and local lock behavior.

Use semantic color classes. Follow local import conventions. Dev tools (TypeScript, Vitest, @types/node) live in `src/ui/package.json` next to the app dependencies. `src/ui/tsconfig.json` is the only tsconfig. Root `Makefile` runs Go checks only, each target in `gotools`. Go lint is golangci-lint with `.golangci.yml`, gofmt included. UI has no linter or formatter. Validate environment variables with Zod in TypeScript and in Go in `internal/config` for `tmuxde` and `internal/stt/config.go` for `tmuxde-stt`. Use conventional commits.

## Plans, Backlogs and Reviews

All plans and backlogs MUST be saved to `.agents/plans/`. Use kebab-case filenames. `.agents/plans/` and `.agents/reviews/` are gitignored. They stay local and never go into commits.

**Plans** are pre-implementation blueprints. Created once, read during execution.

**Backlogs** are living progress trackers for multi-session work. They track what is done, what is in progress, and what remains so any agent or human can resume where the last session left off.

### When to create a backlog

Create a backlog in `.agents/plans/backlogs/{name}-backlog.md` when the work spans multiple phases, multiple sessions, or touches more than 5-10 files. A backlog MUST contain:

1. **Progress summary**: table of phases with status (`[ ]`, `[~]`, `[x]`).
2. **How to resume**: instructions for the next agent or human picking up the work.
3. **Phase checklist**: detailed tasks with checkboxes per phase.
4. **Session notes**: dated entries at the bottom summarizing what each session changed.

### Backlog rules

- Update the backlog after every meaningful change.
- Mark tasks `[x]` as you complete them, `[~]` when in progress, `[!]` when blocked (with reason).
- When the user says to resume work on a feature, check `.agents/plans/backlogs/` for an existing backlog first.
- When executing a multi-phase plan, create a companion backlog in `.agents/plans/backlogs/` if one does not exist.
- Convert relative dates to absolute dates in session notes. Write `2026-04-12`, not "today".

### Reviews

Reviews (security, performance, implementation and others) are saved to `.agents/reviews/{kebab-case}.md` and the same content is the reply to the user. Findings are a few sentences each with file, function and line specifics, plus a fix proposal that was actually verified during the review. No guesses.

## Verification

Run checks appropriate to changes. Browser checks use playwright-cli against the 18443 development instance, whose tmux server lives in `server-dev`. Never type test commands into active user sessions on the host tmux server. Production checks are read only: health, login, session list. Deploy from `.docker` without removing volumes. Secrets and generated binaries stay outside Git and Docker build context.

## Docker development

Run Node and Go tooling only in Docker. Setup: `scripts/setup.sh`. Start hot reload: `docker compose up -d --build --wait`. Checks: `docker compose run --rm tools pnpm test`, `typecheck` or `build`, and `make check` for Go vet, lint and test. Never install host node_modules. Nothing in Docker uses the host tmux.

Docker assets live under .docker. Root docker-compose.yml includes the development config. Production config lives under .docker/compose. Dependency manager downloads with scripts disabled. Approved native builds run offline. Three development volumes hold dependencies, caches and pnpm store. Keep five-day dependency release delay without exclusions.

Dependency mutations use `python3 .docker/dev/dependencies.py mutate` followed by pnpm arguments. A plain run resyncs. The helper stops `ui` while it writes and starts it again. `stt` has no Node packages and keeps running. After a failure run `docker compose up -d --no-build --wait ui`. Host helper exports only manifests and lockfile, with security policy unchanged. Node code is one package in `src/ui` with no pnpm workspace packages. Its `pnpm-workspace.yaml` holds pnpm settings only. workspace.yaml binds the `src/ui` manifests, configs, `index.html`, `public` and `src` one by one at `/workspace`, so a new top level file in `src/ui` needs a bind there. New volume subpaths need directories in init-volumes.sh. Test projects live in `src/ui/vitest.config.ts`. Go containers (`gotools`, `go-vendor`, `server-dev`) bind each part of the Go module on its own, so a new top level Go directory needs a bind in tooling.yaml and dev.yaml and a `COPY` in `tmuxde.Dockerfile`, plus `stt.Dockerfile` when `tmuxde-stt` imports it. `gotools` and `server-dev` also bind `src/ui/src/protocol` read only, where the Go contract test finds the fixtures. Runtime source and dependencies stay read-only. Preserve Caddy volumes, uploads and host tmux sessions.
