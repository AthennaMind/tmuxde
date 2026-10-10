# mtmux local

This fork runs local web client, relay and Caddy through `docker-compose.yml`. CLI, marketing site, hosted broker, billing, database and email apps have been removed. Current setup guide is [.docker/README.md](.docker/README.md).

## Repository map

- `apps/web`: Next.js terminal client, mobile controls, local device lock and repository viewer.
- `apps/relay`: authenticated WebSocket bridge to tmux and local file access.
- `packages/protocol`: validated client/server messages and shared types.
- `packages/crypto`: local cryptography and stored device credentials.
- `packages/ui`, `logger`: shared UI, local logging and configuration.
- `.docker`: supported deployment, host tmux integration and Caddy local CA.
- `docs/reference/upstream`: archived technical docs. Reference material only, not deployment instructions. Hosted and CLI instructions are historical.

## Runtime

Caddy exposes internal HTTPS on port 443. Web and relay have no published ports and use internal Docker network. Preserve Caddy volumes across deployments. Host tmux sessions and upload storage must survive container rebuilds.

Browser assets must be local. No analytics exporters, hosted accounts, cloud dictation or automatic public service requests. Framework telemetry stays disabled during development, builds and runtime. User commands in host tmux retain host network behavior.

## Changes

Protocol changes require schemas, both handlers, tests and updates to `docs/reference/upstream/relay/protocol.mdx`. Relay file access must use path guards. Session operations go through `tmux-manager.ts`. Preserve authentication, origin checks and local lock behavior.

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
