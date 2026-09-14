---
name: deploy-site
description: Build and deploy the mtmux marketing site (apps/site → mtmux.com) to production with PM2. Use this whenever the user wants to deploy, ship, publish, release, restart or reload the site, check whether it is running, read production logs, or debug a production issue such as the site being down or serving a stale build.
---

# Deploy the site

The site is `apps/site` (`@app/site`) in the mtmux monorepo. Production is a `next start`
server supervised by PM2 in **cluster mode** as the app **`mtmux-web`** on port **41317**,
reverse-proxied by nginx.

There is deliberately no PM2 app for `next dev` — `next dev` runs its own watcher, and
supervising it gives you two restart mechanisms fighting each other.

## Two names that must not change

- The PM2 app is **`mtmux-web`**. The port is **41317**, bound to **127.0.0.1**.
- nginx's `server_name mtmux.com` vhost proxies to `http://localhost:41317` and lives in the
  **hand-maintained** `/etc/nginx/conf.d/http.conf` — _not_ the cfx-managed file.

Rename the app or move the port and the public site 502s. Both are defined in the monorepo's
`ecosystem.config.cjs` at the repo root; there is no per-app ecosystem file.

## Normal deploy

Run from the **repo root**:

```bash
pnpm install --frozen-lockfile
pnpm --filter @app/site ship
```

`ship` is `next build` followed by `scripts/promote-build.mjs`, which swaps the finished build
into place and reloads PM2. It is named `ship` rather than `deploy` deliberately: `pnpm deploy`
is a pnpm builtin, so `pnpm --filter @app/site deploy` would silently run pnpm's own command
instead of this one. Run the two halves separately if you want to build now and cut over
later:

```bash
pnpm --filter @app/site build      # writes .next-build, live site untouched
pnpm --filter @app/site promote    # swaps it into .next-serve, reloads mtmux-web
```

`reload` rather than `restart` is the important part: in cluster mode PM2 starts a replacement
worker, waits for it to come up, then retires the old one. Nobody sees a dropped request.
`restart` kills first and asks questions later.

### Three directories, never shared

| Directory     | Written by     | Read by                                  |
| ------------- | -------------- | ---------------------------------------- |
| `.next-dev`   | `next dev`     | the dev server                           |
| `.next-build` | `next build`   | nothing — it is a staging area           |
| `.next-serve` | `promote` only | `next start` under PM2 (`NEXT_DIST_DIR`) |

Builds do **not** write the directory the live server reads. `next build` clears its dist
directory before emitting into it, so building into a tree that a running `next start` is
serving strands that server with a half-build. That is exactly what took `/pricing` and
`/agents` down on 2026-09-09: `.next` lost `BUILD_ID`, every top-level manifest and all of
`server/chunks`, while routes already resident in memory kept answering 200 and hid the damage.

So a stray `turbo build`, `pnpm verify`, or an interrupted deploy can no longer hurt the live
site — the worst case is a fresh build sitting unpromoted in `.next-build`. `promote` refuses
to swap in a build that is missing any of those manifests, and keeps the outgoing tree as
`.next-prev` so a bad cutover can be rolled back without rebuilding:

```bash
mv .next-serve .next-bad && mv .next-prev .next-serve && pm2 reload mtmux-web --update-env
```

Note `pnpm --filter @app/site build`, not `pnpm build` — the latter is `turbo build` across
every app in the monorepo, which is slower and not what a site deploy needs.

## First run on a machine

```bash
pnpm install --frozen-lockfile
pnpm --filter @app/site build
pnpm --filter @app/site promote --no-reload   # seeds .next-serve
pm2 start ecosystem.config.cjs --only mtmux-web
pm2 save        # persist the process list across reboots
```

`--only mtmux-web` matters: `ecosystem.config.cjs` also defines `mtmux-api`, `mtmux-relay`,
`mtmux-app` and `mtmux-docs` for the hosted product. Starting the whole file when you meant to
deploy the marketing site brings up services you did not intend to touch.

`pm2 save` is what makes the app come back after a reboot — without it PM2 starts with an empty
list and the site stays down until someone notices.

## The commands

| Command                                           | What it does                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pm2 start ecosystem.config.cjs --only mtmux-web` | Start it                                                                      |
| `pm2 reload mtmux-web --update-env`               | Zero-downtime rolling restart                                                 |
| `pm2 restart mtmux-web --update-env`              | Hard restart — brief downtime, use only when reload will not pick up a change |
| `pm2 stop mtmux-web`                              | Stop, keep in the process list                                                |
| `pm2 delete mtmux-web`                            | Remove from PM2 entirely                                                      |
| `pm2 logs mtmux-web --lines 100`                  | Tail the last 100 lines                                                       |
| `pm2 status mtmux-web`                            | Health, uptime, restart count, memory                                         |

Logs land in `logs/mtmux-web-out.log` and `logs/mtmux-web-err.log` at the repo root.

## Verify a deploy actually landed

Status alone is not proof — a worker can be `online` and still serving a stale or broken bundle.

```bash
pm2 status mtmux-web
curl -sI localhost:41317 | head -1              # expect HTTP/1.1 200 OK
curl -s localhost:41317 | grep -o '<title>[^<]*'
```

Then confirm the SEO surfaces built, since they are generated rather than hand-written and are
the first thing to break silently:

```bash
curl -s localhost:41317/sitemap.xml | head -20
curl -s localhost:41317/robots.txt
curl -s localhost:41317/feed.xml | head -20
curl -s localhost:41317/llms.txt | head
```

## When something is wrong

**Site is down / 502 from nginx.** Check whether anything is listening: `pm2 status mtmux-web`,
then `ss -ltn | grep 41317`. If PM2 shows a climbing restart count the app is crash-looping —
`pm2 logs mtmux-web` will show why. The usual cause is a missing `apps/site/.next-serve` because the
build failed but the reload ran anyway.

**Serving an old version.** The build did not run or did not finish. Run
`pnpm --filter @app/site ship` explicitly and watch it succeed.

**A page 404s that should exist.** Check the build output for that route. If it is absent, its
`generateStaticParams` returned nothing. If it shows `ƒ (Dynamic)` instead of `●`, the page is
missing `setRequestLocale` — it will still serve, but it is being rendered per request.

**`EADDRINUSE` on 41317 when you run `start` by hand.** That is PM2 already holding the port
with the live site. Do not kill it — serve a build on a scratch port instead:

```bash
pnpm --filter @app/site exec next start --port 41999
```

**Memory climbing.** `max_memory_restart` is 512M per worker, so PM2 recycles a leaking worker
automatically. Repeated memory restarts in `pm2 status` are worth investigating rather than
ignoring.

## Changing the port

Port 41317 is set in the root `ecosystem.config.cjs` and honoured by the package's `start`
script via `${PORT:-41317}`. It is deliberately high and unregistered to stay clear of the
3000/8000/8080 collisions on a box that hosts several apps.

If you change it, the nginx upstream must change to match. The `mtmux.com` vhost is in the
hand-maintained `/etc/nginx/conf.d/http.conf`, so it is **not** covered by the `cloudflare-cfx`
skill and hand-editing it is not something to do unasked. Confirm with the user first.

## Before you deploy

```bash
pnpm --filter @app/site verify     # typecheck + lint + build
```

Worth running on anything non-trivial. The build is the real test: it typechecks, validates every
blog post's frontmatter against its zod schema, and prerenders every route for every locale, so
most mistakes surface there rather than in production.
