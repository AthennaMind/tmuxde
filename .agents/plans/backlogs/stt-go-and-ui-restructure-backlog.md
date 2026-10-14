# stt in Go and ui restructure backlog

Plan: [../stt-go-and-ui-restructure.md](../stt-go-and-ui-restructure.md). Created 2026-10-14.

## Progress summary

| Phase | Status |
|---|---|
| 1a. Go stt code, tests, stt.Dockerfile, image builds | [x] |
| 1b. Node under src/ui, packages folded, Docker and helpers, Go fixture path | [x] |
| 2. stt compose wiring, stt/ removed, README moved | [x] |
| 3. Verification: Go, Node, images, dev stack, browser, python tests | [x] |
| 4. Docs: AGENTS.md, README.md, .docker/README.md, PROTOCOL.md | [x] |
| 5. Review and fixes | [x] |

## How to resume

Read the plan. Check `git status` for what moved. Phases 1a and 1b are independent and run in parallel. Phase 2 needs both. Phase 3 runs after phase 2. Commands live in the plan under Verification. Edits stay uncommitted until the user asks.

## Phase checklist

### 1a. Go stt

- [x] `cmd/tmuxde-stt/main.go` with serve, health, version
- [x] `internal/stt/config.go`, `pcm.go`, `chunker.go`, `segmenter.go`, `transcriber.go`, `server.go`, `session.go`, `socket.go`
- [x] `internal/stt/sherpa/sherpa.go` (cgo, tag sherpa) and `stub.go`
- [x] Tests ported from `stt/src/*.test.ts`, run with `CGO_ENABLED=0`
- [x] `.docker/prod/stt.Dockerfile` with pinned tarball and runtime image
- [x] `docker build -f .docker/prod/stt.Dockerfile -t tmuxde-stt:local .` passes

### 1b. Node under src/ui

- [x] `git mv` of ui, packages sources, fixtures, PROTOCOL.md into `src/ui`
- [x] Imports rewritten, `globals.css` merged, `components.json` aliases
- [x] Unused kit components dropped: `cards.tsx`, `connection-status.tsx`, `empty-state.tsx`, `section.tsx`, `segmented-control.tsx`, `terminal.tsx` from `packages/ui-kit/src/components`. None had an importer. Kept `app-shell.tsx` and `haptic-button.tsx`.
- [x] `src/ui/package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, vitest configs, vite config
- [x] Lockfile regenerated through the installer
- [x] `workspace.yaml`, `tooling.yaml`, `dev.yaml` (ui, server-dev, gotools binds), `init-volumes.sh`, `dependencies.py`, `setup.py`, `tmuxde.Dockerfile`, `.gitignore`, `.air.toml`
- [x] `internal/protocol/fixtures.go` SourceDir
- [x] Root Node files removed

### 2. stt wiring

- [x] `dev.yaml` stt service builds the prod image
- [x] `prod.yaml` stt service
- [x] `stt/` removed, `internal/stt/README.md` in place
- [x] `.docker/tests/runtime.py` still passes

### 3. Verification

- [x] gotools vet and test
- [x] tools typecheck, test, build
- [x] dev stack up, stt healthy, availability log line
- [x] browser sign in and dictation feature flag
- [x] runtime.py and setup_test.py
- [x] prod binary builds to a temp dir
- [x] stale reference grep clean outside docs. Hits left only in `README.md` and `.docker/README.md` for phase 4

### 4. Docs

- [x] AGENTS.md
- [x] README.md
- [x] .docker/README.md
- [x] PROTOCOL.md
- [x] internal/stt/README.md reads as the Go service doc, no change needed

### 5. Review

- [x] Review of the full diff for security invariants and leftovers
- [x] Fixes applied and re-verified

## Session notes

### 2026-10-14

Analysis and decisions. Plan and backlog written. Workflow launched.

Phase 1b done. Node app in `src/ui` with one manifest and lockfile, `packages/` gone, kit folded into `src/ui/src`, one `vitest.config.ts` with projects `unit` and `idb`, Docker helpers and Go fixture path updated. typecheck, 54 test files (990 tests), build, Go protocol tests, prod web stage and compose config pass. The running Node `stt` container stays up but its dev.yaml block now points at a workspace without `stt/`, so it must not be recreated before phase 2.

Phase 1a done 2026-10-14: `tmuxde-stt` in `cmd/tmuxde-stt` and `internal/stt` (plus `sherpa/config.go` for shared settings and `bridge_test.go` that runs the real hub bridge against the server), `internal/stt/README.md`, `.docker/prod/stt.Dockerfile` (installs bzip2 with apt in the build stage, runs as 65532 unless compose sets `user`). Image builds, real models load in about 7.3 s, health exits 0, an English plus Bulgarian clip decodes as two utterances, SIGTERM exits 0 and removes the socket. Compose, runtime.py and `stt/` untouched.

Phase 2 done 2026-10-14: `dev.yaml` and `prod.yaml` `stt` build `.docker/prod/stt.Dockerfile` as `tmuxde-stt:local`, dev hardened like prod, health check from the image. `stt/` removed with `git rm`, its README staged as a rename to `internal/stt/README.md`. The running stt container now runs the Go image, healthy, and server-dev and the host binary both logged `available=true` after a 40 s bounce. runtime.py passes unchanged. Only `.docker/README.md` still links `stt/README.md`.

Phase 3 Go checks 2026-10-14: gotools `go vet ./...`, `go test ./...` (also with `-count=1`), race run over `internal/stt`, `internal/hub/dictation` and `internal/e2e`, and the stt image build pass. `gofmt -l cmd internal web` prints `internal/node/repo/watch.go`. That file is unchanged since commit 599c896, so the drift predates this work. Left unfixed because this step was verification only.

Phase 3 Node and stack checks 2026-10-14: dependency resync unchanged, `pnpm typecheck`, `pnpm test` (54 files, 990 tests) and `pnpm build` pass. Prod binary built to `/tmp/tmuxde-out` and prints `dev`. `docker compose up -d --build --wait` recreated ui, server-dev and stt. All healthy, caddy has no health check. runtime.py and setup_test.py (13 tests) pass. Browser sign in on 18443 renders the session tree (empty after the server-dev recreate) and the `Start dictation` button. Console holds only the service worker SSL line. server-dev logged `available=true`, stt logged `Model loaded` in 7308 ms, no panics or errors. Stale grep hits only in `README.md` and `.docker/README.md`.

Phase 4 docs 2026-10-14: `AGENTS.md` (stt sentence, Server, Protocol, UI and Dictation bullets, repository map, commands without `--filter` plus `docker compose up -d --build stt` and the stt image build, protocol checklist paths, dev tools sentence now points at `src/ui/package.json` and `src/ui/tsconfig.json`, Docker development notes), `README.md` (icon path, layout table), `.docker/README.md` (setup mount point line, ui path, checks, dependencies, dictation with Go service, rebuild, health check and `internal/stt/README.md` link, sherpa-onnx 1.13.8 pin) and `PROTOCOL.md` (fixture test paths, speech service owner) updated. Required grep prints nothing, every written path exists, `pnpm test src/lib/relay-url.test.ts`, the stt Go tests, `tmuxde-stt health` in the running container and `docker compose config --quiet` pass.

Fix round 1 2026-10-14: `gofmt -w internal/node/repo/watch.go` realigned two `Watcher` fields (`pending`, `git`). Only whitespace changed. The compose gotools mounts are read only, so the write ran in `tmuxde-gotools:local` with only `internal/node/repo` bound writable. `gofmt -l cmd internal web` now prints nothing. `go vet` and `go test ./internal/node/repo/` pass.

Phase 3 Go re-run after fix round 1 2026-10-14: gotools `go vet ./...`, `go test ./...` (also `-count=1`), race run over `internal/stt`, `internal/hub/dictation` and `internal/e2e` (also `-count=1`) and the stt image build pass. `gofmt -l cmd internal web` prints nothing. Phase 3 Go box stays ticked.

Phase 3 Node and stack re-run after fix round 1 2026-10-14: dependency resync unchanged, `pnpm typecheck`, `pnpm test` (54 files, 990 tests) and `pnpm build` pass. Prod binary built to `/tmp/tmuxde-out` and prints `dev`. `docker compose up -d --build --wait` brought ui, server-dev and stt up healthy. runtime.py and setup_test.py (13 tests) pass. Browser on 18443 shows the session tree, `Connected` and `Start dictation`, console holds only the service worker SSL lines. server-dev logged `available=true` with no panics, stt logged `Model loaded` with no errors. Stale grep prints nothing, docs included.

### 2026-10-14, cleanup after review

Two review lenses found no high or medium issues. Low findings fixed: `init: true` on stt in both stacks so a stop during the model load ends it, runtime.py asserts stt read only root, cap_drop ALL, no-new-privileges and no ports, dead `workspace_mountpoints` removed from setup.py with its README bullet and the host `src/ui/node_modules` dir, stale comment in `src/ui/src/crypto/envelope.ts`, `ws` override removed from `src/ui/pnpm-workspace.yaml` with the lockfile regenerated, `pcm.go` row in `internal/stt/README.md`, env validation sentence in AGENTS.md names `internal/stt/config.go`. Orphaned `stt`, `ui` and `packages-*` subpaths removed from the dependency volume and the stale `vitest.config.idb.ts` placeholders from the cache volume. Nothing committed.
