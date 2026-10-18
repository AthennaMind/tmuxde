## TmuxDE Development Guide

Local development uses Docker, Make and OpenSSL, with hot reload and two remote agents.

## Start

- clone the repo

```bash
git clone git@github.com:AthennaMind/tmuxde.git
cd tmuxde
```

- create settings and start the stack

```bash
make setup
docker compose up -d --build --wait
```

Open `http://localhost:24200` and sign in with `AUTH_TOKEN` from `.env`; no certificates needed.

- watch logs

```bash
docker compose logs -f
```

## Linting and testing

Commands run inside the started containers.

```bash
make check        # vet, lint, unit tests and typecheck
make lint         # Go and UI lint
make go-lint      # Go lint
make ui-lint      # UI oxlint, format check and knip
make ui-format    # format UI with oxfmt
make test         # Go and UI unit tests
make typecheck    # UI typecheck
make integration  # tmux integration tests
make race         # Go race detector
```

- run specific tests

```bash
make go-test GO_TEST_ARGS='./internal/stt/...'
make ui-test UI_TEST_ARGS='src/protocol/fixtures.test.ts'
```

## Dependencies and builds

```bash
make deps         # install UI dependencies
make ui-build     # build UI assets
make build        # build binary with embedded UI
make help         # list commands
```

Rebuild images after toolchain changes; renew UI dependencies after package changes.

```bash
docker compose up -d --build --wait
docker compose up -d --build --renew-anon-volumes --wait ui
```

## UI layout

- `ui/src/app`: bootstrap, router, routes and providers
- `ui/src/features`: one flat folder per feature, tests co-located
- `ui/src/shared`: cross-cutting helpers
- `ui/src/components/ui`: shadcn primitives
- `ui/src/protocol`: Zod wire schemas shared with Go

Features import each other directly. `shared`, `components/ui` and `protocol` never import features or `app`. `make ui-lint` enforces it.
