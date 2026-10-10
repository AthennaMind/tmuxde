# Remove recordings backlog

Plan: [../remove-recordings.md](../remove-recordings.md)

## Progress summary

| Phase | Status |
| :--- | :--- |
| 1. Protocol | [x] |
| 2. Relay | [x] |
| 3. Web | [x] |
| 4. Workspace and infra | [x] |
| 5. Docs | [x] |
| 6. Verification | [~] |

## How to resume

Read plan first. `git grep -niE "recording|@repo/cast|asciicast"` lists what remains. Replay-attack hits in crypto and transport are not part of this work. Run checks only through `docker compose run --rm tools pnpm <script>`. Dependency changes go through `python3 .docker/dev/dependencies.py mutate install --no-frozen-lockfile`. Never remove Docker volumes.

## Phase 1. Protocol

- [x] Delete `recordings.ts` and its export.
- [x] Drop `recording:*` client and server messages.
- [x] Drop `recordings` arm of `GrantScope`.
- [x] Fix comments and tests that name recordings.

## Phase 2. Relay

- [x] Delete `recorder.ts`, `recordings-index.ts` and their tests.
- [x] Router: drop handlers, chunk streaming, visibility helpers.
- [x] Policy: drop allow-list, `recordingTarget`, recording entries.
- [x] Grant: drop `allowsRecording`, `isRecordingsGrant`, recordings branches.
- [x] Server: drop `GET /recording`.
- [x] Wire connections: drop feature flag, sweep, shutdown stop.
- [x] Connection manager scope and tmux recording clone.
- [x] Tests updated.

## Phase 3. Web

- [x] Delete `/r` routes, `components/recording`, store, `cast-fetch`, `player-clock` and tests.
- [x] Toolbar, websocket hook, layout redirect, connection store helpers.
- [x] `xterm-factory.ts` comment.

## Phase 4. Workspace and infra

- [x] Delete `packages/cast`. Drop `@repo/cast` dependencies.
- [x] Docker mounts and volume init for `packages/cast`. Root Vitest project entry.
- [x] Caddy `/recording` route.
- [x] Lockfile through dependency helper.

## Phase 5. Docs

- [x] `AGENTS.md` repository map.
- [x] Archived docs: delete `recording.mdx`, nav entry, recording sections and links.

## Phase 6. Verification

- [x] `pnpm typecheck`, `pnpm test`, `pnpm build`.
- [!] Dev stack healthy. `/r` 404 confirmed over HTTP. Browser toolbar check blocked: host Chromium libraries (`libnss3`, `libnspr4`, GTK) were removed from host at 23:24, outside this session.
- [x] Prod images build.

## Session notes

### 2026-10-10

- Tooling simplification from same day is uncommitted. Its tree is snapshotted as `3db90be` so both changes can be committed separately.
- All phases done except browser toolbar check (blocked, see Phase 6).
- Recording removal vs tooling snapshot: 65 files, +117/-5029. 27 files deleted, including `packages/cast`, relay recorder and index, web player, store, routes and `docs/reference/upstream/recording.mdx`.
- Checks: `pnpm typecheck` passes. `pnpm test` runs 70 files, 1033 tests. `pnpm build` passes. Relay bundle 172.8kb to 146.3kb.
- First typecheck after deleting `/r` failed on stale `.next-build/types/validator.ts` in tools cache. Next regenerates it on build. Second typecheck passed.
- Prod images build. Offline smoke: relay `/health` 200, `/recording` 404. Web `/login` 200, `/r` 404.
- Caddy reloaded in place after `/recording` matcher removal.
- Orphan `packages-cast` subdirectory stays inside dependency volume. Harmless. Volumes were not touched.
- Landed as two commits on branch `chore/tooling-and-recording-cleanup`: tooling first, then this removal.
