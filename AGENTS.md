# tmuxde

## Project

Self-hosted browser IDE backed by tmux, forked from [mtmux/mtmux](https://github.com/mtmux/mtmux). Repository: [AthennaMind/tmuxde](https://github.com/AthennaMind/tmuxde).

Selected machine, session and pane define workspace context: folder, files, repository and changes. Preserve that context across tabs and reconnects.

`tmuxde` is one Go binary with `serve`, `agent`, `machine` and `version` commands. Server serves UI and manages local tmux by default. Agents connect remote machines with their own tmux, files and Git. `TMUXDE_LOCAL_NODE=false` disables server's local node.

Browser login uses `AUTH_TOKEN`. Agents use separate machine credentials. Hosted broker, pairing, accounts, billing and Node relay are gone. Remote machine support is active.

Closing browser or locking UI leaves tmux running. Stopping or recreating dev containers ends their tmux processes. Agent workspaces inside containers are disposable.

## Code map

| Path | Responsibility |
| --- | --- |
| `cmd/tmuxde` | Server, agent and machine credential commands |
| `internal/hub` | Browser authentication, WebSockets, HTTP routes, files and dictation |
| `internal/machine` | Agent connections, registry, remote nodes and inventory |
| `internal/node` | Local tmux, PTY, files, repositories and watchers |
| `internal/config` | Server and agent environment validation |
| `internal/protocol` | Go wire types, registries and contract tests |
| `src/ui/src/protocol` | Zod schemas, fixtures and `PROTOCOL.md` |
| `src/ui` | React, Vite, React Router, xterm.js and Zustand |
| `web` | Embeds production UI from `web/dist` |
| `cmd/tmuxde-stt`, `internal/stt` | Optional speech binary and engine |
| `cmd/tmuxde-stt/internal/bundle` | Command-owned model embedding and extraction |

UI routes live in `src/ui/src/router.tsx`; remote sessions use `/m/:machineId/s/:sessionId`. Machine state lives in `stores/machine-store.ts` and `components/machine-workspace.tsx`. WebSocket handling lives in `lib/ws-client.ts` and `hooks/use-websocket.ts`.

Local lock code lives in `lib/lock-store.ts`, `lib/lock-controller.ts` and `components/lock`. Locking clears decrypted credentials and browser connections, not tmux sessions.

Speech uses Parakeet and Silero through sherpa-onnx. Default Go checks use stub engine. Dev STT uses `sherpa`; releases also use `stt_bundle`. Shared `internal/stt` must not contain embedded model payloads.

## Local development

Follow [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Host needs Git, Docker Compose, Make and OpenSSL. Run local Go, Node, pnpm, lint, tests and builds inside dev containers. Do not install host development toolchains or host `node_modules`.

Root `docker-compose.yml` is development only, under project `tmuxde-dev`:

| Service | Role |
| --- | --- |
| `ui` | Vite with HMR |
| `server-dev` | Go server with Air and local dev tmux |
| `stt` | Speech service with Air, shared Unix socket and no network |
| `agent-alpha`, `agent-beta` | Remote agents with Air and separate tmux servers |

Open `http://localhost:24200`. Agents connect to `http://server-dev:24200` with `TMUXDE_DEV_ALLOW_HTTP=true`. Local setup needs no certificates or reverse proxy. Agent configuration requires HTTPS unless that dev option is explicitly enabled.

Keep Compose flat: no includes, profiles, extra tooling services, per-file source binds or volume subpaths. Each service mounts `.:/workspace` read/write. Never mount host tmux or production sockets.

UI dependencies use anonymous `node_modules` volume. Go cache, dev home and speech socket use named volumes. Hub registry and agent tokens live under ignored `.local/dev`. Root `.env` holds token, host UID/GID and optional proxy hostname.

`dev.Dockerfile` owns development toolchains, including golangci-lint. `Dockerfile` owns production builds. Do not recreate `.docker` or setup scripts.

## Commands

Start stack before Make tooling targets; they use `docker compose exec`.

```sh
make setup
docker compose up -d --build --wait
make check
make integration
make race
```

| Command | Runs |
| --- | --- |
| `make check` | Vet, lint, Go unit tests, UI tests and typecheck |
| `make vet`, `make lint` | Go checks in `server-dev` |
| `make test` | Go and UI unit tests |
| `make go-test`, `make ui-test` | Selected test suite |
| `make typecheck` | UI TypeScript check |
| `make integration` | External-process Go tests |
| `make race` | Go unit tests with race detector |
| `make deps` | Frozen UI install and approved offline rebuilds |
| `make ui-build` | UI build copied into `web/dist` |
| `make ui` | UI typecheck and asset build |
| `make build` | Linux `dist/tmuxde` with embedded UI |

`make check` does not build UI or run integration tests. Use `GO_TEST_ARGS` or `UI_TEST_ARGS` to select tests:

```sh
make go-test GO_TEST_ARGS='./internal/stt/...'
make ui-test UI_TEST_ARGS='src/protocol/fixtures.test.ts'
```

Dependency changes run inside containers. Keep pnpm's five-day release delay, disabled install scripts and approved offline rebuilds. Keep Go dependencies vendored and normal builds offline. Rebuild dev images after toolchain changes; renew UI dependency volume after package changes.

## Change rules

- Protocol edits need Zod schemas, Go types and registries, valid/invalid fixtures, handlers and `src/ui/src/protocol/PROTOCOL.md` updates. Check both Go and UI contracts.
- Update Go routing in `internal/node/local` and browser handling in `hooks/use-websocket.ts`; update machine forwarding when affected.
- File access goes through guards in `internal/node/files`. Tmux operations go through `internal/node/tmux`.
- Keep remote file, repository and terminal operations scoped to their machine. Do not replay mutations after connection loss.
- Preserve authentication, origin checks, credential redaction and local lock behavior. Browser tokens and agent tokens are separate.
- Validate Go settings in `internal/config` or `internal/stt/config.go`; use Zod for TypeScript environment settings.
- Use semantic color classes and existing `@/` imports. UI tooling stays in `src/ui/package.json`; UI has no linter or formatter. Go formatting uses gofmt.
- Browser assets stay local. No telemetry, hosted accounts, cloud dictation or automatic public runtime requests.

## Verification

Default Go suite contains unit tests. Tests needing tmux, Git or shell processes use `//go:build integration` and `TestIntegration` names. Use private test sockets and temporary repositories. Lint includes integration source.

Run checks relevant to changes. Do not automatically rebuild images or rerun full suites after every edit. Documentation changes need link and whitespace checks, not application builds. Report checks not run.

Browser checks target local dev at `http://localhost:24200`, or configured dev HTTPS from local notes. Never type test commands into active user tmux sessions. Production checks are read only: health, login and session list.

## CI and releases

`.github/workflows/checks.yml` runs on PRs against main, main pushes and reusable calls. Path filters select Go lint/unit/integration and UI jobs. UI protocol changes also trigger Go checks; workflow and GoReleaser changes trigger both. UI checks typecheck and test without building.

Gitleaks scans checked-out history on every check run with redacted output. Its CLI download is pinned, cached and checksum verified. Integration jobs test multiple pinned tmux versions.

`.github/workflows/release.yml` calls checks with `full-checks: true` on `v*` tags. Binary publishing waits for checks; image publishing waits for binaries and checks.

CI uses direct native commands and official setup, golangci-lint, GoReleaser and Docker actions. Keep commands visible in YAML; no repository scripts or Make wrappers. Actions read Go version from `go.mod`.

Preserve caches for Go, pnpm, tmux, Gitleaks and verified speech downloads. Main warms speech assets. Image builds use per-image GHCR `buildcache` tags across releases.

GoReleaser publishes stripped Linux amd64/arm64 archives for `tmuxde` and `tmuxde-stt`. Build UI into `web/dist` before compiling server. Speech libraries and model hashes come from `cmd/tmuxde-stt/assets.json`; released speech binary includes its models.

Production Dockerfile builds from source without external build artifacts. Default `tmuxde` target includes UI, tmux, Git and Bash on Alpine. `tmuxde-stt` target contains static bundled speech binary on distroless. Both images support amd64/arm64. Server and agent use same image.

## Local state and writing

Read ignored `AGENTS.local.md` when present. Host-specific URLs, addresses, service paths and certificate details belong there. Local native production is separate from dev Compose. Preserve its sessions, uploads and certificate keys; keep machine values and secrets out of tracked files and Docker build context.

Use short sentences, no emojis or long dashes. Preserve user's documentation style. README prose uses TmuxDE; executable names, paths and module remain `tmuxde`. Use conventional commits.

## Plans and reviews

Plans and backlogs belong in `.agents/plans/`; reviews belong in `.agents/reviews/`. These directories are ignored and must not be committed. Use kebab-case filenames.

Create `.agents/plans/backlogs/{name}-backlog.md` for work spanning phases, sessions or more than 5-10 files. Include phase status table, resume instructions, task checklists and dated session notes. Use `[ ]`, `[~]`, `[x]` and `[!]` for pending, active, done and blocked work.

Check existing backlogs before resuming work. Update them after meaningful changes. Give each multi-phase plan a companion backlog. Plans describe intended work; backlogs track progress. Use absolute dates in notes.

Save requested reviews with verified findings, file/function/line details and concrete fixes. Reply with same review content. Do not invent findings.
