# Tooling simplification backlog

Plan: [../tooling-simplification.md](../tooling-simplification.md)

## Progress summary

| Phase | Status |
| :--- | :--- |
| 1. Manifests and configs | [x] |
| 2. Docker development stack | [x] |
| 3. Dependency sync and checks | [x] |
| 4. Production Dockerfiles | [x] |
| 5. Documentation | [x] |

## How to resume

Read plan first. Check unchecked tasks below. Run checks only through `docker compose run --rm tools pnpm <script>`. Dependency changes go through `python3 .docker/dev/dependencies.py mutate install --no-frozen-lockfile`. Never remove Docker volumes.

## Phase 1. Manifests and configs

- [x] Root `package.json`: pnpm scripts, root devDependencies, drop turbo and prettier.
- [x] `pnpm-workspace.yaml`: drop `tooling/*`.
- [x] Root `tsconfig.base.json`. Package tsconfigs extend it. Drop `.turbo` tsbuildinfo paths.
- [x] Root `vitest.config.ts` with projects. Drop per-package vitest configs that only set defaults.
- [x] Package manifests: drop eslint, typescript, vitest, `@types/node`, `@repo/tsconfig`, `@repo/eslint-config`, lint and test scripts.
- [x] Relay: `build` runs esbuild bundle, `start` runs bundle.
- [x] Delete `turbo.json`, `tooling/`, `.prettierignore`, per-package `eslint.config.js`.
- [x] `.gitignore`, `.dockerignore`, `.env.example`: drop turbo, add `.cache`.

## Phase 2. Docker development stack

- [x] `workspace.yaml`: drop turbo, tooling and eslint mounts. Add root config binds and one `.cache` mount.
- [x] `init-volumes.sh`: drop tooling and turbo directories. Add root cache directory.
- [x] `dependencies.py`: drop `tooling` manifest glob.
- [x] Dev Dockerfile, tooling and prod compose: drop `TURBO_TELEMETRY_DISABLED`.

## Phase 3. Dependency sync and checks

- [x] Lockfile updated through dependency helper. `typescript@6.0.3` and `turbo` gone.
- [x] `pnpm typecheck`, `pnpm test`, `pnpm build` pass in tools container.
- [x] Dev stack healthy after restart.

## Phase 4. Production Dockerfiles

- [x] Web Dockerfile without turbo. Image builds.
- [x] Relay Dockerfile without turbo. Image builds.

## Phase 5. Documentation

- [x] `README.md`, `AGENTS.md`, `.docker/README.md` updated.

## Session notes

### 2026-10-10

- Baseline before changes: typecheck, lint (0 errors, 9 warnings) and tests pass under turbo.
- Confirmed `typescript@7.0.2` is current npm `latest` and already native. TS 6.0.3 only served typescript-eslint.
- User asked to drop linters too, pending oxlint and oxfmt migration.
- Phases 1 to 3 and 5 done. Lockfile dropped 121 packages, including `typescript@6.0.3`, turbo, ESLint stack and Prettier.
- Checks after change: `pnpm typecheck` passes (8s). `pnpm test` runs 77 files, 1153 tests in one Vitest run (29s with 4 workers). `pnpm build` passes, Next type check uses root TS 7.
- Dev stack healthy. Headless Chromium load of `/login` shows HMR connected with no tsconfig issues. First dev start after change showed stale Turbopack cache errors for `extends`. Restart of web cleared them.
- Editing single-file bind mounts with `sed -i` swaps inodes, so running containers keep stale content. Write files in place instead.
- Relay prod runner still copies full filtered `node_modules`, matching previous behavior. Prod-only install would shrink image. Not done.
- Prod images build with manifests stage plus filtered install. `rebuild --pending` needs same filter, otherwise it fetches skipped packages and fails offline.
- Smoke runs with `--network none`: relay `/health` 200, web `/login` 200. Relay image 1.57GB to 1.38GB. Web unchanged at 346MB.
