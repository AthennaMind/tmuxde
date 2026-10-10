# Development

Requires Node.js 22, pnpm 9.15.4 and tmux. Docker setup is documented in [local stack guide](docker/local/README.md).

```bash
pnpm install
pnpm dev
```

Web listens on localhost:14100. Relay listens on localhost:14300. Export environment settings described in `.env.example` before starting. Development token defaults to `change-me-in-production` on loopback only. Network binds require a private token.

Run checks before sharing changes:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Use isolated tmux sessions for browser tests. Never send test input into someone else's active session. `pnpm lab` manages an isolated test container.

Use conventional commits. Keep file operations behind relay path guards. Preserve local authentication and permission checks. Do not add hosted service dependencies, telemetry exporters or remote assets.

Archived upstream docs live in `docs/reference/upstream`. They describe historical CLI and hosted features as well as shared protocols. Current deployment instructions live in `docker/local/README.md`.
