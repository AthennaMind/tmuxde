# stt in Go and ui restructure

Created 2026-10-14. Companion backlog: [backlogs/stt-go-and-ui-restructure-backlog.md](backlogs/stt-go-and-ui-restructure-backlog.md).

## Goal

Two changes, one effort.

1. Speech service `stt` becomes a Go binary `tmuxde-stt` in the existing Go module. Node leaves the speech container. Wire contract with the Go bridge in `internal/hub/dictation` stays identical.
2. All Node code moves under `src/ui`. `packages/protocol`, `packages/crypto` and `packages/ui-kit` fold into `src/ui/src`. One `package.json`, one lockfile, no workspace packages. `packages/` and `stt/` are gone.

Go module stays at the repository root: `cmd`, `internal`, `web`, `go.mod`, `go.sum`, `vendor`, `.air.toml`.

## Decisions (2026-10-14)

- Go module at repo root. Only Node moves to `src/ui`.
- stt in development builds the production image. Rebuild by hand with `docker compose up -d --build stt`. No air for stt.
- ui-kit flattens into the existing `components/ui`, `hooks`, `providers`, `lib` directories of the ui app.
- Execution as a multi-agent workflow. Edits stay uncommitted.

## Part 1: stt in Go

### Engine binding

sherpa-onnx stays the engine, same models, same decode path. Official Go modules `sherpa-onnx-go` and `sherpa-onnx-go-linux` carry 32 MB of shared objects inside the module and `go mod vendor` drops non package directories, so they break the offline `-mod=vendor` build. Instead: own cgo binding against the sherpa-onnx C API.

- Pinned release: sherpa-onnx v1.13.8, published 2026-09-10, older than the five day delay.
- Tarball with headers and libs: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2`, 28156791 bytes, sha256 `c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4`. Contains `lib/libsherpa-onnx-c-api.so`, `lib/libonnxruntime.so`, `lib/libsherpa-onnx-cxx-api.so` and `include/sherpa-onnx/c-api/c-api.h`.
- aarch64 libs only tarball for a later multi arch build: `sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu-lib.tar.bz2`, sha256 `fb98b80628a383909bf83626daca2e0d0ffc93bf1f7d222eaaa4282b388f072f`. Not wired now. x86_64 only.
- `libsherpa-onnx-c-api.so` has RPATH `$ORIGIN` and needs `libonnxruntime.so`, libstdc++, glibc 2.17. `debian:bookworm-slim` satisfies this. Runtime image ships only those two `.so` files and the binary.
- Zero new Go modules. `vendor/` unchanged. `coder/websocket` (already vendored) serves the WebSocket route.
- Binding behind build tag `sherpa` and cgo: `//go:build sherpa && cgo`. A stub file with the inverse tag returns an error from `Load`. `go vet ./...` and `go test ./...` in gotools stay `CGO_ENABLED=0` and never see the C header. Only the stt image builds with `CGO_ENABLED=1 -tags sherpa`.

### Code layout

```
cmd/tmuxde-stt/main.go       subcommands: serve (default), health, version
internal/stt/config.go       env: STT_SOCKET (required, absolute, max 107 bytes), STT_MODEL_DIR, STT_VAD_MODEL (optional), STT_THREADS (1..64, default 4), STT_MAX_SESSIONS (1..64, default 4), STT_MAX_SECONDS (10..3600, default 600)
internal/stt/pcm.go          SampleRate 16000, PCM16 little endian to float32, odd byte count is an error
internal/stt/chunker.go      AudioChunker: 30 s chunks cut at the quietest 100 ms window in the last 5 s
internal/stt/segmenter.go    Segmenter interface (Push, Flush), ChunkSegmenter, History ring (30 s), VADSegmenter with 300 ms pre-roll over a VAD interface, bounded to 30 s pieces
internal/stt/transcriber.go  Transcriber interface, Serialize (one decode at a time, keeps going after a failure), ModelFiles check
internal/stt/server.go       http.Server for a unix socket: GET /health -> {"ok":true,"model":..,"sessions":n}, /v1/stream WebSocket, anything else 404, over the session cap close 1013 Busy, read limit 256 KiB
internal/stt/session.go      one dictation: binary frames are audio, text {"type":"stop"} ends it, ready/text/done/error messages, MinPieceSamples 1600, idle timeout 60 s, length cap then stop as if asked, close 1000 after done, 1011 on error
internal/stt/socket.go       Listen on path, remove a stale socket file (not a socket: error, something answers: error), remove on close
internal/stt/sherpa/sherpa.go  cgo binding: OfflineRecognizer (transducer encoder/decoder/joiner int8, tokens, greedy_search, feature dim 80, cpu) and VoiceActivityDetector (Silero, threshold 0.5, min silence 0.6 s, min speech 0.25 s, window 512, max speech 25 s, buffer 60 s)
internal/stt/sherpa/stub.go    inverse build tag, Load returns an error naming the build tag
internal/stt/README.md         moved from stt/README.md, numbers kept, Node references updated
```

Logging: `log/slog` JSON handler on stdout, same fields as today (`model`, `threads`, `segments`, `ms`, `audioSeconds`, `decodeMs`, `wallMs`, `outcome`). Never log transcripts or audio.

Signals: SIGTERM and SIGINT close the server, close client connections, remove the socket, exit 0 within 2 s.

Decode runs serialized on one goroutine. cgo calls block an OS thread, which is fine for one decode at a time. VAD objects are per session and are destroyed when the session ends.

Tests port `stt/src/*.test.ts` to Go: health, 404 upgrade, transcribe after stop, short tail skipped, chunking while audio arrives, length cap, bad audio, bad message, failed decode (error text never leaks), idle close, session cap, stale socket, live socket, non socket path, serialize order and recovery, chunker and segmenter unit tests. A counting fake transcriber replaces the model. No test loads sherpa.

### Image

`.docker/prod/stt.Dockerfile`:

1. `golang:1.27.2-bookworm` pinned by digest (same as `tmuxde.Dockerfile`). Download the tarball with curl, verify sha256, extract to `/opt/sherpa-onnx`.
2. `COPY go.mod go.sum vendor cmd internal` as in `tmuxde.Dockerfile`. Build with `CGO_ENABLED=1 GOFLAGS=-mod=vendor GOPROXY=off CGO_CFLAGS=-I/opt/sherpa-onnx/include CGO_LDFLAGS="-L/opt/sherpa-onnx/lib -lsherpa-onnx-c-api -lonnxruntime -Wl,-rpath,/usr/local/lib/sherpa-onnx"` and `-tags sherpa -trimpath -ldflags "-s -w"`.
3. Runtime `debian:bookworm-slim` pinned by digest. Copy the two `.so` files to `/usr/local/lib/sherpa-onnx` and the binary to `/usr/local/bin/tmuxde-stt`. `USER 65532` style nonroot or compose `user:` as today. `ENV STT_SOCKET=/run/tmuxde/stt/stt.sock`. `HEALTHCHECK CMD ["tmuxde-stt","health"]` dials the socket and GETs `/health`.
4. `CMD ["tmuxde-stt","serve"]`.

Compose:

- `dev.yaml` `stt`: `build: context ../.., dockerfile .docker/prod/stt.Dockerfile`, `image: tmuxde-stt:local`, hardening as `prod.yaml` (`read_only`, `cap_drop ALL`, `no-new-privileges`, `pids_limit`, tmpfs `/tmp`), `network_mode: none`, same `user`, `environment` and `volumes`, no `depends_on deps-build`, no `extends workspace.yaml`. Health check from the image.
- `prod.yaml` `stt`: drop the node health check if any, keep the rest.
- `.docker/tests/runtime.py`: keep the stt assertions, they do not depend on Node.

## Part 2: Node under src/ui

### Target tree

```
src/ui/
  package.json           name "tmuxde-ui", merged dependencies of ui, protocol, crypto and ui-kit, devDependencies of root and ui, scripts dev/build/preview/typecheck/test
  pnpm-lock.yaml         regenerated inside the installer
  pnpm-workspace.yaml    pnpm settings only (overrides, allowBuilds, release age, store, strict flags). No packages list, or packages: ["."] if pnpm 12 needs it. Verify.
  tsconfig.json          root tsconfig.base.json merged in, paths @/* -> ./src/*
  vite.config.ts         optimizeDeps.entries: index.html only
  vitest.config.ts       two projects inline: default (src/**/*.test.ts minus idb) and idb (fake-indexeddb setup). Root vitest.config.ts goes away. No @repo inline deps.
  vitest.config.idb.ts   kept if the two project split stays as two files
  postcss.config.mjs, components.json, index.html, public/, .nvmrc
  src/
    protocol/            packages/protocol/src/*.ts, fixtures/, PROTOCOL.md
    crypto/              packages/crypto/src/*.ts
    components/ui/       packages/ui-kit/src/components/ui/*.tsx
    components/          app-shell.tsx, haptic-button.tsx and any other kit component with an importer. Kit components with zero importers after the move are dropped and listed in the backlog.
    hooks/               use-media-query.ts, use-debounce.ts, use-theme.ts
    providers/           toast-provider.tsx, theme-provider.tsx
    lib/                 utils.ts, brand.ts, terminal-themes.ts
    globals.css          ui-kit globals.css content first (tailwind, tw-animate-css, tokens, theme), then the app part. The @source directive and the @repo import go.
```

Import mapping, applied with sed over `src/ui/src`:

| From | To |
|---|---|
| `@repo/protocol` | `@/protocol` |
| `@repo/crypto` | `@/crypto` |
| `@repo/ui/lib/utils` | `@/lib/utils` |
| `@repo/ui/lib/brand` | `@/lib/brand` |
| `@repo/ui/terminal-themes` | `@/lib/terminal-themes` |
| `@repo/ui/components/ui/X` | `@/components/ui/X` |
| `@repo/ui/components/X` | `@/components/X` |
| `@repo/ui/hooks/X` | `@/hooks/X` |
| `@repo/ui/providers/X` | `@/providers/X` |

Relative imports inside moved kit files keep working because depth from `src/` is preserved. `components.json` aliases become `@/lib/utils`, `@/components/ui`, `@/hooks`.

Name collision: `packages/ui-kit/src/components/terminal.tsx` versus the existing `ui/src/components/terminal/` directory. The kit file has no importer. Drop it. Check every kit file the same way.

Protocol tests `codec.test.ts` and `repository.test.ts` read fixtures relative to their own file. Check the paths after the move. `fixtures.test.ts` lives where? Confirm with a listing and keep it next to the fixtures.

### Go side

- `internal/protocol/fixtures.go` `SourceDir`: walk up looking for `src/ui/src/protocol/client-messages.ts`. Update comments and error text.
- `.air.toml` `exclude_dir`: add `src`.
- `tooling.yaml` gotools and `dev.yaml` server-dev: bind `../../src/ui/src/protocol` to `/workspace/src/ui/src/protocol`.

### Docker and helpers

- `workspace.yaml`: `/workspace` is `src/ui`. `runtime` binds `src/ui/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,tsconfig.json,vite.config.ts,vitest.config.ts,vitest.config.idb.ts,postcss.config.mjs,components.json,index.html,public,src}`. Dependency volume subpath `root` at `/workspace/node_modules`. All `stt` and `packages-*` subpaths and binds go. `workspace` and `ui-workspace` mount the writable metadata volume at `/workspace` and `.vite` at `/workspace/.vite`, file binds on top. `installer` tmpfs: `/workspace` only. Manifest binds: the three `src/ui` manifests under `/manifests/`.
- `init-volumes.sh`: subpaths `root`, `workspace-cache`, `ui-vite`, `ui-tooling-metadata`, `ui-dev-metadata`, `go-build`, `go-mod`.
- `deps-manager.sh`: unchanged logic, no filters.
- `dependencies.py`: `MANIFESTS` are the three `src/ui` manifests. `resume` is `['ui']` only. Fingerprint file list unchanged otherwise.
- `setup.py` `workspace_mountpoints`: `src/ui/node_modules`. Keep `setup_test.py` green.
- `dev.yaml` `ui`: command `vite --configLoader native --host 0.0.0.0 --port 24100`, no filter. Health check unchanged.
- `tmuxde.Dockerfile` web stage: copy the three manifests from `src/ui`, `pnpm install --frozen-lockfile --ignore-scripts`, offline rebuild, `COPY src/ui .`, `pnpm build`, Go stage copies `/app/dist`.
- `.gitignore`: `ui/.vite/` becomes `src/ui/.vite/`.
- `.dockerignore`: unchanged unless a path needs it.
- Root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.nvmrc`, `node_modules/` leave the root.
- `ui/vite.config.ts` cache dir logic: `/workspace/.vite` in the container.

### Docs

- `AGENTS.md`: architecture lines for stt and protocol, repository map, commands (`pnpm` commands lose `--filter @app/ui`, dependency mutate loses the filter, add `docker compose up -d --build stt`), Docker development notes (workspaces, mountpoints, Go directories).
- `README.md`: layout table.
- `.docker/README.md`: dependencies, dictation, toolchain pins (sherpa-onnx 1.13.8, checked 2026-10-14), stt README link.
- `src/ui/src/protocol/PROTOCOL.md`: path references.
- `.docker/README.md` and `AGENTS.md` say `stt` builds from `.docker/prod/stt.Dockerfile` in both stacks.

## Verification

- `docker compose run --rm gotools go vet ./...` and `go test ./...`.
- `python3 .docker/dev/dependencies.py` (resync), then `docker compose run --rm tools pnpm typecheck`, `pnpm test`, `pnpm build`.
- `docker build -f .docker/prod/stt.Dockerfile -t tmuxde-stt:local .` compiles the cgo binding.
- `docker compose up -d --build --wait` with the dictation profile already in `.env`. `docker compose ps` shows stt healthy. `docker compose logs server-dev` shows `Speech service availability changed available=true`.
- Browser check per the recipe in `.agents/plans/backlogs/git-surfaces-backlog.md`: sign in on 18443, session list renders, `auth:success` features include `dictation`.
- `python3 .docker/tests/runtime.py` and `python3 -B .docker/dev/setup_test.py`.
- Production binary build to a temp dir: `docker build -f .docker/prod/tmuxde.Dockerfile --target binary --output type=local,dest=/tmp/tmuxde-out .`. Never overwrite `.docker/bin/tmuxde`.
- `grep -rn "packages/\|@repo/\|@app/\|stt/src\|sherpa-onnx-node"` over tracked files returns only history notes under `.agents`.

## Out of scope

- aarch64 image. Pins recorded above for later.
- Dependency upgrades. Every pin stays.
- Any change to the browser protocol or the dictation bridge.
