# tmuxde

## What this is

tmuxde (Tmux Development Environment) is a self-hosted web terminal for tmux. It serves host tmux sessions to any browser on private network, mainly phones and tablets. User opens existing session from phone, types into it, scrolls history, uploads photos as file paths and browses repository files and Git changes. Main use case is driving long-running coding agents (Claude Code, Codex) and shells away from host keyboard. tmux owns session state. Closing browser, locking device or rebuilding containers never kills sessions.

Repository is [AthennaMind/tmuxde](https://github.com/AthennaMind/tmuxde). It is a fork of [mtmux/mtmux](https://github.com/mtmux/mtmux) (git remote `upstream`). Upstream ships `mtmux` npm CLI, QR and code pairing, hosted broker, sealed tunnel, accounts and billing. This fork removed CLI, marketing site, hosted broker, billing, database and email apps. What remains is web client and relay, run by Docker Compose behind Caddy with local CA. Sign-in uses relay token from `.docker/.env.token`. Current setup guide is [.docker/README.md](.docker/README.md).

## Architecture

```
Browser ─https/wss:443─► Caddy ─┬─► web:24100   Next.js client
                                └─► relay:24300 /_relay /_pair/* /_sessions /file /health
relay ─ node-pty `tmux attach-session` ─► host tmux socket (mounted)
relay ─ execFile tmux ─► list, capture, create, kill sessions
relay ─ read-only bind of host home ─► Files and Changes viewer
```

- `.docker/Caddyfile`: routes relay paths to relay, everything else to web. Rejects non-private IPs. Sets CSP and permissions policy. Redirects upstream code entry routes (`/start`, `/pair`, `/j`) to `/login`.
- Relay (`apps/relay/src`): `index.ts` checks tmux, starts HTTP server (`server.ts`) and WebSocket server (`ws-server.ts`). `wire-connections.ts` handles per-socket auth, caps, liveness and grants. `message-router.ts` dispatches every client message after `policy.ts` checks grant scope. `tmux-manager.ts` wraps tmux CLI. `pty-bridge.ts` attaches PTY with output backpressure. `session-monitor.ts` polls window and pane layout changes. `file-service.ts` and `repository-service.ts` enforce `ALLOWED_PATHS` and block credential directories. `config.ts` validates env with Zod.
- Protocol (`packages/protocol`): Zod discriminated unions `ClientMessage` and `ServerMessage`, one JSON object per WebSocket message (`codec.ts`). `policy.test.ts` fails if new message type has no policy entry.
- Web (`apps/web/src`): App Router with `(auth)` login routes and `(terminal)/s/[sessionId]`. `lib/ws-client.ts` owns reconnect, backoff and message queue over `lib/transport.ts`. `hooks/use-websocket.ts` applies server messages to Zustand stores in `stores/`. Terminal uses xterm.js (`lib/xterm-factory.ts`). Mobile controls live in `components/mobile`. Repository viewer lives in `components/files` with bundled Shiki highlighting.
- Local lock: `lib/lock-store.ts`, `lib/lock-controller.ts` and `components/lock` keep stored credentials encrypted under in-memory master key, unlocked by PIN or passkey PRF. Locking drops key, disconnects and clears stores. It never touches tmux.
- Relay clones (`tmux-clone.ts`) are grouped sessions created for read-only shares so viewers cannot switch sessions. They stay hidden from every session list.

Inherited upstream code is still wired in: local pairing (`pairing-local.ts`), scoped grants, device approval and `SealedTransport`. Standalone stack does not issue pairing codes. Check whether path is reachable in local stack before changing it.

## Repository map

- `apps/web`: Next.js terminal client, mobile controls, local device lock and repository viewer.
- `apps/relay`: authenticated WebSocket bridge to tmux and local file access.
- `packages/protocol`: validated client/server messages and shared types.
- `packages/crypto`: local cryptography and stored device credentials.
- `packages/ui`, `logger`: shared UI, local logging and configuration.
- `.docker`: supported deployment, host tmux integration and Caddy local CA.
- `scripts/setup.sh`: writes `.env`, token and copies host tmux client into `.docker/host-tmux`.
- `docs/reference/upstream`: archived technical docs. Reference material only, not deployment instructions. Hosted and CLI instructions are historical. Exception: `relay/protocol.mdx` is maintained.
- `docs/superpowers/plans`: older dated plans from fork cleanup. New plans go to `.agents/plans/`.
- `.agents/skills`: UI review skills (`better-*`, `interface-review`).

## Commands

All Node tooling runs in Docker. Run from repository root.

```sh
scripts/setup.sh                                  # first run, or after host tmux change
docker compose up -d --build --wait               # dev stack with hot reload
docker compose run --rm tools pnpm test           # all Vitest projects
docker compose run --rm tools pnpm test apps/relay/src/auth.test.ts   # single file
docker compose run --rm tools pnpm typecheck
docker compose run --rm tools pnpm build
docker compose logs -f
docker compose down                               # keeps volumes and tmux sessions
python3 .docker/dev/dependencies.py mutate --filter @app/web add <pkg>
python3 .docker/tests/runtime.py                  # relay HOME check
```

Dev URL is `https://localhost` on `127.0.0.1`. Override with `LOCAL_DOMAIN` and `LOCAL_BIND_IP` in root `.env`. Production uses `.docker/compose/prod.yaml`.

## Runtime

Caddy exposes internal HTTPS on port 443. Web and relay have no published ports and use internal Docker network. Preserve Caddy volumes across deployments. Host tmux sessions and upload storage must survive container rebuilds.

Browser assets must be local. No analytics exporters, hosted accounts, cloud dictation or automatic public service requests. Framework telemetry stays disabled during development, builds and runtime. User commands in host tmux retain host network behavior.

## Changes

Protocol changes require schemas, both handlers, tests and updates to `docs/reference/upstream/relay/protocol.mdx`. Both handlers means relay `message-router.ts` and web `use-websocket.ts`. New message types also need entry in relay `policy.ts`. Relay file access must use path guards. Session operations go through `tmux-manager.ts`. Preserve authentication, origin checks and local lock behavior.

Use semantic color classes. Follow local import conventions. Shared dev tools (TypeScript, Vitest, @types/node) live in root package.json. Package tsconfigs extend root tsconfig.base.json. No task runner, linter or formatter. Validate environment variables with Zod. Use conventional commits.

## Plans, Backlogs and Reviews

All plans and backlogs MUST be saved to `.agents/plans/`. Use kebab-case filenames.

**Plans** are pre-implementation blueprints. Created once, read during execution.

**Backlogs** are living progress trackers for multi-session work. They track what is done, what is in progress, and what remains so any agent or human can resume where the last session left off.

### When to create a backlog

Create a backlog in `.agents/plans/backlogs/{name}-backlog.md` when the work spans multiple phases, multiple sessions, or touches more than 5-10 files. A backlog MUST contain:

1. **Progress summary**: table of phases with status (`[ ]`, `[~]`, `[x]`).
2. **How to resume**: instructions for the next agent or human picking up the work.
3. **Phase checklist**: detailed tasks with checkboxes per phase.
4. **Session notes**: dated entries at the bottom summarizing what each session changed.

### Backlog rules

- Update the backlog after every meaningful change. Commit it alongside the work.
- Mark tasks `[x]` as you complete them, `[~]` when in progress, `[!]` when blocked (with reason).
- When the user says to resume work on a feature, check `.agents/plans/backlogs/` for an existing backlog first.
- When executing a multi-phase plan, create a companion backlog in `.agents/plans/backlogs/` if one does not exist.
- Convert relative dates to absolute dates in session notes. Write `2026-04-12`, not "today".

### Reviews

Reviews (security, performance, implementation and others) are saved to `.agents/reviews/{kebab-case}.md` and the same content is the reply to the user. Findings are a few sentences each with file, function and line specifics, plus a fix proposal that was actually verified during the review. No guesses.

## Verification

Run checks appropriate to changes. Browser checks use playwright-cli against running stack, in isolated tmux sessions. Never type test commands into active user sessions. Deploy from `.docker` without removing volumes. Secrets and generated host binaries stay outside Git and Docker build context.

## Docker development

Run Node tooling only in Docker. Setup: scripts/setup.sh. Start hot reload: docker compose up -d --build --wait. Checks: docker compose run --rm tools pnpm test, typecheck or build. Never install host node_modules.

Docker assets live under .docker. Root docker-compose.yml includes standalone development config. Production config lives under .docker/compose. Dependency manager downloads with scripts disabled. Approved native builds run offline. Three development volumes hold dependencies, caches and pnpm store. Keep five-day dependency release delay without exclusions.

Dependency mutations use python3 .docker/dev/dependencies.py mutate followed by pnpm arguments. Host helper exports only manifests and lockfile, with security policy unchanged. New workspaces need subpath mounts in workspace.yaml and directories in init-volumes.sh. Workspaces with tests also need an entry in root vitest.config.ts projects. Runtime source and dependencies stay read-only. Preserve Caddy volumes, uploads and host tmux sessions.
