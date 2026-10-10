# mtmux local

Local web terminal connects browser to host tmux through relay and Caddy. Development runs entirely in Docker.

## Developer quick start

Requires Linux x86_64 with glibc, Docker Compose with volume subpath support, Python 3 and host tmux. Start a tmux session first. Run these commands from repository root:

```sh
scripts/setup.sh
docker compose up -d --build --wait
```

Setup creates private `.env`, preserves relay token and prepares host tmux client. No host Node or pnpm installation needed.

Open `https://localhost`. Trust [Caddy local CA](.docker/README.md), then sign in with token from `.docker/.env.token`. Default HTTPS bind address is `127.0.0.1`. Set `LOCAL_BIND_IP` and `LOCAL_DOMAIN` in root `.env` if your machine needs different settings.

Root `docker-compose.yml` includes `.docker/compose/dev.yaml`. Browser connects through Caddy on HTTPS port 443. Caddy routes pages to Next.js web client and WebSocket traffic to relay, which connects to host tmux socket. Web and relay have no published ports. Editing source triggers Next.js hot reload and relay restart.

Startup initializes three volumes for dependencies, caches and pnpm store. Dependency container downloads packages with scripts disabled, then separate container builds approved native dependencies offline. Apps start afterward. Unchanged dependency hashes skip installation. Caddy certificates, uploads and host tmux sessions survive rebuilds.

Workspaces use plain pnpm with no task runner. Root `tsconfig.base.json` and `vitest.config.ts` hold shared TypeScript 7 and test settings. Root `pnpm test` runs every workspace suite in one Vitest run. No linter or formatter is configured yet.

Run checks and Node commands inside tooling container:

```sh
docker compose run --rm tools pnpm test
docker compose run --rm tools pnpm typecheck
docker compose run --rm tools pnpm build
docker compose logs -f
docker compose down
```

Stopping Compose leaves host tmux sessions running. Keep Docker volumes when stopping or rebuilding.

## Dependencies and browser tests

Dependency changes need restricted export back to host manifests. Helper stops running development services while changing dependencies:

```sh
python3 .docker/dev/dependencies.py mutate --filter @app/web add package-name
```

No host Node, pnpm or node_modules installs. Downloads disable lifecycle scripts. Approved native builds have no network. Runtime uses nonroot users, read-only source and dependencies, dropped capabilities and no privilege escalation.

[Docker setup and certificate guide](.docker/README.md) covers local configuration and device trust.

Browser checks use `playwright-cli` against running stack when needed.

Production is explicit:

```sh
docker compose --env-file .env -f .docker/compose/prod.yaml up -d --build --wait
```

Production and development share project and Caddy volume names. Switch modes after `docker compose down`. Keep volumes.

Repository: `apps/web`, `apps/relay`, shared `packages`, Docker configuration under `.docker/`. Archived upstream docs describe historical hosted features.

After editing dependency manifests manually, stop web and relay before rerunning `docker compose up -d --build --wait`.
