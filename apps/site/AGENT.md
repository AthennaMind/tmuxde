<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# apps/site (mtmux.com) — agent guide

**`CLAUDE.md` is the canonical, full contract for this package.** Read it before writing code.
This file is the quick reference: the things that most often go wrong, and where to look.

This is the `@app/site` workspace package in the mtmux monorepo; it is built and run with pnpm,
either from here or as `pnpm --filter @app/site <script>` from the repo root.

## What this is

Marketing site, docs and blog for **mtmux**, a CLI that serves live tmux sessions to any browser
with agent-aware push notifications. Next.js 16 App Router, Tailwind v4, shadcn/ui on Base UI,
next-intl, MDX blog, PM2 in production.

The pre-Next.js prototype is archived in `_legacy/`. It is the **content** source of truth for
the port — never the markup source of truth. Rebuild against the design system; do not transcribe
its inline styles.

## The six rules that break things

1. **No hardcoded colours.** Every colour is a token in `src/app/globals.css`. A hex code, an
   `oklch(...)` or a stock Tailwind colour (`text-zinc-400`) in a `.tsx` file is a bug. Both
   schemes ship — light in `:root`, dark in `.dark` — and hand-written components still never
   need a `dark:` variant, because every token name exists in both. A subtree that draws a
   terminal carries `terminal-scope` and stays dark in either scheme.

2. **`params` is a Promise.** Next 16 removed the sync fallback. `const { locale } = await params;`

3. **`setRequestLocale(locale)` before any translation call**, at the top of every page. Omit it
   and the route silently becomes dynamic — the build marks it `ƒ` instead of `●` and the static
   HTML is gone.

4. **`Link` comes from `@/i18n/navigation`**, never `next/link`. The latter breaks every
   non-default locale.

5. **No literal English in components.** Copy lives in `messages/<locale>/<namespace>.json`,
   where the file name is the namespace. `alt` text, `aria-label`s and visually hidden strings
   count as copy.

6. **Titles are keyword-first with no brand suffix.** Never `Features | mtmux`. Titles are ranking
   real estate; brand attribution is carried by `og:site_name`, the Organization JSON-LD and the
   visible logo. Always build metadata with `buildMetadata` from `@/lib/seo`.

## Next 16 specifics worth knowing

- Next deprecates `middleware.ts` in favour of `proxy.ts`, but the file here is deliberately
  **`src/middleware.ts`** — next-intl documents the middleware entry point and both re-enter
  identically. The reason is written at the top of the file; read it before renaming anything.
- `ImageResponse` imports from **`next/og`**, not `next/server`.
- `next lint` is removed — run `eslint` directly (`pnpm lint`).
- Turbopack is the default bundler for `next build`.
- `next start` is the production server, so `output: "standalone"` is deliberately **not** set —
  the two are alternatives, not complements.

## Where things live

```
src/app/[locale]/          one directory per page; the document shell is layout.tsx
src/components/primitives/ the site's visual language — compose from these
src/components/sections/   page-specific composed sections
src/components/ui/         shadcn — regenerate, don't hand-edit
src/config/site.ts         domain, version, install command, nav, sitemap routes
src/i18n/                  locales, routing, navigation, message loading
src/lib/                   seo, structured-data, blog, mdx, utils
content/blog/<locale>/     posts, one directory per language
messages/<locale>/         copy, one JSON file per namespace
```

## Product facts (keep consistent everywhere)

Verify anything here against source before writing it down. This file has been wrong before.

- Install is **`npm i -g mtmux`** — the _only_ install method shown anywhere on the site.
- The version badge is read from `apps/cli/package.json` at build time — never typed into
  `src/config/site.ts`. Requires **Node 22+ and tmux**; macOS, Linux, WSL2.
- The command surface is exactly what `apps/cli/src/bin.ts` defines: `start` (the default),
  `local`, `pair`, `status`, `stop`, `doctor`, `login`/`logout`/`whoami`, `servers`, `devices`,
  `upgrade`, `token`, `version`. **If it is not in that file, it does not exist** — do not
  document `up`, `down`, `watch`, `run`, `notify`, `share` or `sessions`.
- **There is no notification product.** No push, no Slack/Discord/webhook routing, no
  `agents.toml`, no agent presets, no done/blocked/stalled/failed states, no hooks API. The
  honest agent story is _pull, not push_: you open the session on a phone and look at it.
- Plans come from `packages/config/src/plans.ts`, mirrored in `src/config/plans.ts` — never
  typed into a message file. Free: 1 server, 3 devices, 5 GB/month relayed. Pro: $10/mo or
  $100/yr, unlimited servers and devices, 200 GB/month. Payments are **Dodo Payments**.
- Crypto, verified against `packages/crypto/src/`: pairing is a **CPace PAKE over ristretto255**
  (`CPACE-RISTR255-SHA512`); the 6-digit code is a 2-digit routing slot plus a 4-digit secret the
  broker never receives; **HKDF-SHA256** key schedule; **AES-256-GCM** frames with per-direction
  nonces and a replay-rejecting counter; the QR carries the code in a URL **fragment**.
- **No independent security audit has happened.** Never imply one has.
- Real hosts: **`app.mtmux.com`** (web client) and **`api.mtmux.com`** (pairing broker).
  Self-hosting is real via `MTMUX_API_URL` / `MTMUX_BUILD_API_URL`.
- No unsourced performance numbers. "0 ports to forward" is fine; a latency figure is not.

## Skills

Repeatable jobs are captured as skills in `.claude/skills/` — use them rather than reconstructing
the steps:

| Task                                     | Skill           |
| ---------------------------------------- | --------------- |
| Write or publish a blog post             | `add-blog-post` |
| Add a language / translate the site      | `add-language`  |
| Add a marketing or content page          | `add-page`      |
| Change colours, fonts or theme           | `retheme-site`  |
| Build, deploy, restart, debug production | `deploy-site`   |

## Verification

```bash
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm build        # every route must be ● (SSG), not ƒ (Dynamic)
pnpm verify       # all three
```

The build is the real test: it typechecks, validates every blog post's frontmatter against its
zod schema, and prerenders every route for every locale.

Before claiming a colour change is done:

```bash
grep -rnE '#[0-9a-fA-F]{3,8}\b|oklch\(|(text|bg|border)-(zinc|slate|gray|green|red|blue|amber)-[0-9]' \
  src/components src/app --include=*.tsx
```

That must return nothing.
