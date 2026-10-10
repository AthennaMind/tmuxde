# mtmux local

This fork runs local web client, relay and Caddy through `docker-compose.yml`. CLI, marketing site, hosted broker, billing, database and email apps have been removed.

## Repository map

- `apps/web`: Next.js terminal client, mobile controls, local device lock and repository viewer.
- `apps/relay`: authenticated WebSocket bridge to tmux, local file access and recordings.
- `packages/protocol`: validated client/server messages and shared types.
- `packages/crypto`: local cryptography and stored device credentials.
- `packages/cast`: recording codecs and playback helpers.
- `packages/ui`, `logger`: shared UI, local logging and configuration.
- `.docker`: supported deployment, host tmux integration and Caddy local CA.
- `.docker/lab`: isolated test container.
- `docs/reference/upstream`: archived technical docs. Hosted and CLI instructions are historical.

## Runtime

Caddy exposes internal HTTPS on port 443. Web and relay have no published ports and use internal Docker network. Preserve Caddy volumes across deployments. Host tmux sessions and upload storage must survive container rebuilds.

Browser assets must be local. No analytics exporters, hosted accounts, cloud dictation or automatic public service requests. Framework telemetry stays disabled during development, builds and runtime. User commands in host tmux retain host network behavior.

## Changes

Protocol changes require schemas, both handlers, tests and updates to `docs/reference/upstream/relay/protocol.mdx`. Relay file access must use path guards. Session operations go through `tmux-manager.ts`. Preserve authentication, origin checks and local lock behavior.

Use semantic color classes. Follow local import conventions. Validate environment variables with Zod. Use conventional commits.

## Verification

Run checks appropriate to changes. Use isolated tmux sessions for browser tests. Never type test commands into active user sessions. Deploy from `.docker` without removing volumes. Secrets and generated host binaries stay outside Git and Docker build context.

## Docker development

Run Node tooling only in Docker. Setup: scripts/setup.sh. Start hot reload: docker compose up -d --build --wait. Checks: docker compose run --rm tools pnpm test, lint, typecheck or build. Never install host node_modules.

Docker assets live under .docker. Root docker-compose.yml includes standalone development config. Production and lab configs live under .docker/compose. Dependency manager downloads with scripts disabled. Approved native builds run offline. Three development volumes hold dependencies, caches and pnpm store. Keep five-day dependency release delay without exclusions.

Dependency mutations use python3 .docker/dev/dependencies.py mutate followed by pnpm arguments. Host helper exports only manifests and lockfile, with security policy unchanged. New workspaces need subpath mounts in workspace.yaml and directories in init-volumes.sh. Runtime source and dependencies stay read-only. Terminal tests use .docker/dev/lab.sh with isolated sessions. Preserve Caddy volumes, uploads and host tmux sessions.
