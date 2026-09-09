# Contributing to mtmux

Thanks for your interest in contributing to mtmux. This guide will help you get started.

## Prerequisites

- **Node.js** 22 or later
- **pnpm** 9 or later
- **tmux** installed and available on your PATH

## Getting Started

1. Fork and clone the repository:

   ```bash
   git clone https://github.com/<your-username>/mtmux.git
   cd mtmux
   ```

2. Install dependencies and set up the project:

   ```bash
   pnpm setup
   ```

   This runs `pnpm install` and creates a `.env` file from the template.

3. Start development:

   ```bash
   pnpm dev
   ```

4. Open `http://localhost:14100`. Web and relay share that one port — the same
   layout `mtmux start` ships — with the relay WebSocket at `/_relay`. The
   startup banner prints a login URL containing the dev token.

   Use `pnpm dev:split` if you need the split web (`14100`) + relay (`14300`)
   model that the Docker and PM2 deployments use, `pnpm dev:pairing` for the
   hosted-pairing topology with the broker included, and `pnpm dev:docs` for the
   docs site (`14102`).

## Pull Request Process

1. Create a feature branch from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

2. Make your changes and ensure they pass checks:

   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

3. Commit using **conventional commits** (see below).

4. Push your branch and open a pull request against `main`.

5. Fill out the PR template and wait for review.

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

**Types:** `feat`, `fix`, `chore`, `docs`, `refactor`, `test`

**Scopes** — enforced by `commitlint.config.js`, so anything else fails the
commit hook:

`cli`, `web`, `site`, `docs`, `relay`, `api`, `protocol`, `crypto`, `db`,
`ui`, `config`, `logger`, `infra`, `ci`, `deps`

The scope is optional; when present it must be one of those.

Examples:

```
feat(cli): add mtmux doctor
fix(relay): handle disconnection during PTY resize
feat(crypto): bind the slot into the CPace channel identifier
chore(deps): upgrade to Next.js 16
docs: update setup instructions
```

## The invariants

Some changes are refused on sight, not because the code is wrong but because
they contradict a promise the product makes. `CLAUDE.md` lists all of them; the
four that most often catch a well-meant patch:

- **The six-digit secret never reaches the broker** — not in a request, not as
  a hash. If a change makes the broker able to test a guess offline, it is a
  break of the central claim, not an optimisation.
- **The broker logs counts and outcomes only.** No code, slot, mailbox id,
  ciphertext, or address-to-mailbox mapping.
- **The self-hosted path works with zero contact with our servers**, and
  **accounts are optional forever**. `mtmux start --local` must never need a
  network.
- **Plan limits live only in `packages/config/src/plans.ts`.**

A pull request that touches pairing, the broker, or the frame codec is expected
to add adversarial tests — the ones that assert the bad thing *cannot* happen.
That is most of what the existing suite is.

## Code Style

- **TypeScript** throughout; strict mode enabled.
- **ESM only** (`type: "module"` in all packages). Use `.js` extensions for local imports.
- **Tailwind CSS** with semantic classes (`bg-background`, `text-foreground`). Never use raw color utilities.
- Run `pnpm lint` to check formatting and linting rules before committing.
- Internal packages use the `@repo/*` namespace; apps use `@app/*`.

## Project Structure

See `CLAUDE.md` for a detailed overview of the repository layout, key commands, and architectural patterns.
