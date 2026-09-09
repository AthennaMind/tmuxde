---
name: deploy-docs
description: Build and deploy the mtmux documentation site (apps/docs → docs.mtmux.com) to production with PM2. Use this whenever the user wants to deploy, ship, publish, release, restart or reload the docs, check whether the docs site is running, read its production logs, or debug a docs production problem such as a 502, a stale build or a dead search box.
---

# Deploy the docs

The docs site is `apps/docs` (`@app/docs`) in the mtmux monorepo — Next.js 16 + Fumadocs 16.
Production is a `next start` server supervised by PM2 in **fork** mode as the app
**`mtmux-docs`** on port **24102**.

This is the sibling of `deploy-site` (which ships `apps/site` → mtmux.com as `mtmux-web` on
41317). Read that skill for anything about the marketing site; do not mix the two up, because
mtmux.com **also** serves a `/docs` page and it is a different thing entirely.

## Read this before the first deploy

**`mtmux-docs` has never run on this box.** Nothing has ever listened on 24102. That changes
the first command you run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @app/docs build
pm2 start ecosystem.config.cjs --only mtmux-docs   # start, NOT reload
pm2 save                                            # survive a reboot
```

`pm2 reload mtmux-docs` on a process PM2 has never heard of fails; it is not a no-op you can
run "just in case". After the first successful `start` + `save`, every later deploy uses the
normal flow below.

`--only mtmux-docs` matters: `ecosystem.config.cjs` at the repo root also defines `mtmux-api`,
`mtmux-app`, `mtmux-relay` and `mtmux-web`. Starting the whole file when you meant to ship the
docs brings up services you did not intend to touch.

## Normal deploy (after the first run)

From the **repo root**:

```bash
pnpm install --frozen-lockfile
pnpm --filter @app/docs build
pm2 reload mtmux-docs --update-env
```

**Always build before reloading.** `next start` serves whatever is in `apps/docs/.next` when a
worker boots. Reloading without a fresh build restarts the old bundle; reloading *during* a
build can serve a half-written one.

Note `pnpm --filter @app/docs build`, not `pnpm build` — the latter is `turbo build` across
every app in the monorepo.

## Not yet reachable from the internet — and why you must not fix it by hand

There is **no `docs.mtmux.com` vhost anywhere on this box.** `grep -rn docs.mtmux.com
/etc/nginx/` returns nothing. So even a perfectly healthy process on 24102 is not publicly
reachable: it needs a proxied DNS record and an nginx server block.

Do **not** hand-edit nginx to add one.

- `/etc/nginx/conf.d/http.conf` holds `mtmux.com` → 41317 and is **read-only** — hand-maintained
  inventory that cfx refuses to write to.
- `api.mtmux.com` → 24400 and `app.mtmux.com` → 24100 live in
  `/etc/nginx/conf.d/cfx-managed.conf`, which is generated. `docs.mtmux.com` belongs there too.

The right tool is the **`cloudflare-cfx`** skill, which does DNS and the vhost in one command
(`cfx site create docs.mtmux.com --port 24102`). Read that skill before running anything: it
records two live blockers on this box — no Cloudflare API token is configured, and `sudo -n`
fails so cfx cannot reload nginx itself, meaning a created site is staged rather than live.

**Standing up a new public hostname is a decision, not a deploy step. Confirm with the user
first.**

## The commands

| Command                                            | What it does                                     |
| -------------------------------------------------- | ------------------------------------------------ |
| `pm2 start ecosystem.config.cjs --only mtmux-docs` | Start it (first run only), then `pm2 save`        |
| `pm2 reload mtmux-docs --update-env`               | Restart with the new build                        |
| `pm2 restart mtmux-docs --update-env`              | Hard restart — use when reload will not pick up   |
| `pm2 stop mtmux-docs`                              | Stop, keep in the process list                    |
| `pm2 delete mtmux-docs`                            | Remove from PM2 entirely                          |
| `pm2 logs mtmux-docs --lines 100`                  | Tail the last 100 lines                           |
| `pm2 status mtmux-docs`                            | Health, uptime, restart count, memory             |

Logs land in `logs/mtmux-docs-out.log` and `logs/mtmux-docs-err.log` at the repo root.

In **fork** mode there is one worker, so `reload` is a restart with a short gap rather than the
zero-downtime rolling replacement `mtmux-web` gets from cluster mode. That is fine for a docs
site and is not worth changing.

## Verify a deploy actually landed

Status alone is not proof — a worker can be `online` and serving a stale bundle.

```bash
pm2 status mtmux-docs
ss -ltn | grep 24102                                 # something must be listening
curl -sI localhost:24102/docs | head -1              # expect HTTP/1.1 200 OK
curl -s localhost:24102/docs | grep -o '<title>[^<]*'
```

Then check the four generated surfaces, which are the ones that break silently:

```bash
# Search. A 404 here means src/app/api/search/route.ts is missing or the build
# dropped it — the symptom users see is a search box that finds nothing, ever.
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  'localhost:24102/api/search?query=pairing'
curl -s 'localhost:24102/api/search?query=pairing' | head -c 200

curl -s localhost:24102/sitemap.xml | grep -c '<url>'   # one per MDX page
curl -s localhost:24102/llms.txt | head
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' localhost:24102/llms-full.txt

# Per-page OG card — must be image/png, not text/html
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' localhost:24102/og/pairing
```

## When something is wrong

**502 from nginx.** Only meaningful once a vhost exists. Check `pm2 status mtmux-docs`, then
`ss -ltn | grep 24102`. A climbing restart count means a crash loop — `pm2 logs mtmux-docs`
will say why, and the usual cause is a missing `apps/docs/.next` because the build failed but
the reload ran anyway.

**Search returns nothing for every query.** `/api/search` is 404ing. Confirm the route exists
at `apps/docs/src/app/api/search/route.ts` and that the build output listed `ƒ /api/search`.
Note `next.config.ts` sets `pageExtensions: ["tsx","ts","jsx","js"]` — a route file with an
extension outside that list is silently not a route.

**A page 404s that should exist.** Its MDX file is missing from `content/docs`, or the build
failed. Note the inverse is *not* a 404: a page left out of `meta.json` disappears from the
sidebar but stays routable and stays in the sitemap. See the `add-doc-page` skill.

**`/docs/claude-code-remote` behaves oddly.** It is a 308 to `/docs/agents/claude-code`,
defined in `next.config.ts`. That is deliberate.

**`EADDRINUSE` on 24102 by hand.** PM2 already holds it. Do not kill it — serve on a scratch
port instead:

```bash
pnpm --filter @app/docs exec next start --port 14873
```

**Memory climbing.** `max_memory_restart` is 512M. Repeated memory restarts in `pm2 status`
are worth investigating rather than ignoring.

## Before you deploy

```bash
pnpm --filter @app/docs typecheck
pnpm --filter @app/docs lint
pnpm --filter @app/docs build
```

The build is the real test: it typechecks, validates every MDX file's frontmatter against the
Fumadocs page schema, prerenders all docs pages and generates one Open Graph card per page. A
frontmatter typo or a broken component fails there rather than in production.

## Two names that must not change

- The PM2 app is **`mtmux-docs`**. The port is **24102**.
- Both are defined in the monorepo's root `ecosystem.config.cjs`; there is no per-app ecosystem
  file. The package's `start` script also hardcodes 14102 for local use — production uses the
  `args: "start --port 24102"` in the ecosystem file, not that script.

Change either and the future `docs.mtmux.com` vhost points at nothing.
