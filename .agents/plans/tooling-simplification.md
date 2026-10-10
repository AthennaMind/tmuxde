# Tooling simplification

Created 2026-10-10. Companion backlog: [backlogs/tooling-simplification-backlog.md](backlogs/tooling-simplification-backlog.md).

## Goal

Plain pnpm workspaces with no task runner. TypeScript 7 native compiler only. Shared dev tools live at workspace root. Linters and formatter removed until oxlint and oxfmt adoption.

## Starting point

- pnpm workspaces already in place. Turbo 2.11.7 only orchestrated `build`, `lint`, `typecheck`, `test`, `dev`.
- `typescript@7.0.2` (native Go compiler, current `latest`) already pinned in every package.
- typescript-eslint 8.71.1 caps its peer at `<6.1.0`, so lockfile also carried `typescript@6.0.3` for lint only.
- Three template packages under `tooling/`: `@repo/tsconfig`, `@repo/eslint-config`, `@repo/prettier-config`. Prettier config was never wired.
- Docker dev compose mounted 12 writable `.turbo` cache paths plus 3 `tooling/*` dependency subpaths.
- Prod Dockerfiles used `turbo prune --docker` for manifest-only install layers.

## Target

- Root `package.json` scripts call pnpm directly: `pnpm -r build`, `pnpm -r typecheck`, `vitest run`.
- Root devDependencies: `typescript`, `@types/node`, `vitest`. pnpm already exposes root `node_modules/.bin` to workspace scripts.
- Root `tsconfig.base.json` replaces `@repo/tsconfig`. Type checking never emits.
- Root `vitest.config.ts` runs every test project in one process. One writable `.cache` mount replaces all `.turbo` mounts.
- Relay `build` bundles with esbuild directly. Unused `tsc` emit removed.
- ESLint, typescript-eslint, React hooks and Next lint plugins, Prettier and per-package lint configs removed. `typescript@6.0.3` leaves lockfile.
- Prod Dockerfiles copy manifests in a small stage instead of `turbo prune`, then install with pnpm filters.

## Out of scope

- oxlint and oxfmt adoption.
- Dependency version upgrades. All pins stay.
- Archived docs under `docs/reference/upstream`.
