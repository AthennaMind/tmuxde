# apps/site — mtmux.com

Marketing site, docs and blog for **mtmux** — a CLI that serves the tmux sessions you already run
to any browser, over an end-to-end encrypted tunnel with nothing to port-forward.

This is the `@app/site` workspace package inside the mtmux monorepo. Run everything through
pnpm from the repo root (`pnpm --filter @app/site <script>`) or with pnpm from this directory.
The root `CLAUDE.md` governs the monorepo; this file governs the site and wins on anything
site-specific.

The pre-Next.js site is archived in `_legacy/` as prototype HTML. It is the **content**
source of truth for the port, never the markup source of truth — rebuild, don't transcribe.

---

## Read this before you run tmux

This repo is _about_ tmux, so you will be tempted to run tmux to check a claim before
writing it down. Doing that is fine. Doing it on the **default socket is not** — this box
runs long-lived tmux sessions driving real agents, and a bare `tmux` command attaches to
them.

**Every tmux command you run must be scoped to a throwaway socket with `-L`.**

```bash
# WRONG — these hit the user's live sessions and destroy hours of work
tmux kill-server
tmux kill-session -t foo
tmux attach
rm -f /tmp/tmux-$(id -u)/default

# RIGHT — scoped to a private socket that nobody else is using
tmux -L scratch new -d -s foo
tmux -L scratch ls
tmux -L scratch kill-server     # only ever kills your own scratch server
```

Rules, in order of importance:

1. **Never** run `tmux kill-server`, `kill-session`, or `attach` without `-L`.
2. **Never** `rm` anything under `/tmp/tmux-*/`. The socket is not yours to delete.
3. Always `tmux -L scratch kill-server` when you are done, so you leave no debris.
4. `-L <name>` picks a socket in `/tmp/tmux-$(id -u)/`; use a name nobody would pick by
   accident, not `default`.

This is not hypothetical. On 2026-07-27 a subagent verifying tmux error strings for a blog
post ran `tmux kill-server; rm -f /tmp/tmux-$(id -u)/default; tmux attach` and killed the
user's live `ai-agents` session mid-run.

---

## Stack

| Concern         | Choice                                                                 |
| --------------- | ---------------------------------------------------------------------- |
| Framework       | Next.js 16 (App Router, Turbopack, React 19)                           |
| Styling         | Tailwind CSS v4, CSS-first config — no `tailwind.config.*`             |
| Components      | shadcn/ui `base-nova` style on Base UI (`@base-ui/react`), RTL enabled |
| i18n            | next-intl 4, `localePrefix: "as-needed"`, statically rendered          |
| Content         | MDX via `next-mdx-remote-client`, Shiki highlighting                   |
| Process manager | PM2, production server only                                            |
| Package manager | **pnpm** (this is `apps/site` in the mtmux monorepo)                   |

Next 16 changed things your training data may predate. Before writing framework code,
check `node_modules/next/dist/docs/`. Specifically:

- `params` and `searchParams` are **Promises**. Always `await params`.
- Next deprecates `middleware.ts` in favour of `proxy.ts`, but this site deliberately keeps
  **`src/middleware.ts`**: both re-enter identically and next-intl documents the middleware
  entry point, so this stays on its supported path. The full reasoning is in the file's header
  comment — read it before renaming anything.
- `ImageResponse` is imported from **`next/og`**, not `next/server`.
- `next lint` is removed; use `eslint` directly.

---

## Non-negotiable conventions

### 1. No hardcoded colours. Ever.

Every colour lives in `src/app/globals.css`. Components use semantic Tailwind utilities
that map to those tokens. A hex code, an `oklch(...)`, or a stock Tailwind colour
(`text-zinc-400`, `bg-green-500`) in a `.tsx` file is a bug.

```tsx
// ✗ never
<div className="bg-[#0C0E0C] text-green-400">
// ✓ always
<div className="bg-surface-raised text-brand">
```

Available token families:

- **Surfaces** — `surface-base`, `surface-raised`, `surface-panel`, `surface-sunken`, `surface-inverse`
- **Lines** — `line-subtle`, `line`, `line-strong`
- **Text** — `text-strong`, `text`, `text-muted`, `text-subtle`, `text-faint`, `text-inverse`
- **Brand** — `brand`, `brand-hover`, `brand-contrast`, `brand-subtle`
- **Signals** — `signal-done`, `signal-blocked`, `signal-stalled`, `signal-failed`,
  `signal-agent`, each with a matching `-surface` variant. These are _generic_ status colours;
  they are **not** agent lifecycle states (see "There is no notification product" below)
- **Terminal syntax** — `term-prompt`, `term-path`, `term-value`, `term-comment`,
  `term-keyword`, `term-flag`, `term-added`, `term-removed`

**Both schemes ship.** Light values live in `:root`, dark values in `.dark`, and every token
name exists in both — so a component still never needs a `dark:` variant. `<html>` is served
with `class="dark"` (the canonical look) and the pre-paint script in `src/lib/theme.ts` swaps it
before first paint for anyone who chose light or whose OS asks for it; `ThemeToggle` cycles
system → light → dark. Writing a `dark:` variant in a hand-written component is still a bug: if
a value differs per scheme, it belongs in the token, not the markup.

Two things are deliberately scheme-independent, both defined once in "Layer 1a":

- **Terminal illustrations.** A terminal is dark everywhere in a developer's life, and ANSI
  colours picked against black are unreadable on paper. Any subtree that draws one carries
  `terminal-scope`, which remaps the surface/line/text tokens onto the fixed `--t-*` palette.
- **`term-*` syntax colours**, for the same reason.

Retheming the entire site = editing the `:root` and `.dark` blocks in `globals.css`.

### 2. Fonts are variables, not imports

- `font-display` — Martian Mono. Headings only, set globally on `h1`–`h4`.
- `font-sans` — IBM Plex Sans. Body copy, UI.
- `font-mono` — IBM Plex Mono. Code, terminal output, keycaps, eyebrows, metadata.

### 3. All user-facing text is translated

No literal English in components. Copy lives in `messages/<locale>/<namespace>.json`,
one file per page or feature area, read with `useTranslations("namespace")` (client) or
`getTranslations("namespace")` (server).

Namespaces are file names: `messages/en/home.json` → `useTranslations("home")`.

`alt` text, `aria-label`s and visually hidden strings count as user-facing text.

### 4. Links go through next-intl

```tsx
import { Link } from "@/i18n/navigation"; // ✓ locale-aware
import Link from "next/link"; // ✗ breaks non-default locales
```

### 5. Every page sets metadata via the factory

```tsx
export async function generateMetadata({ params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "features" });
  return buildMetadata({
    locale: locale as Locale,
    path: "/features",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}
```

`buildMetadata` handles canonical URLs, bidirectional hreflang + `x-default`, Open Graph,
Twitter cards and robots directives.

### 6. Every page opts into static rendering

```tsx
const { locale } = await params;
setRequestLocale(locale);
```

Omitting this silently makes the route dynamic and costs the build its static HTML.

### 7. Page titles are keyword-first and carry no brand suffix

Do **not** write `Features | mtmux`. Titles are ranking real estate; a new domain gains
nothing from spending characters on a brand nobody searches for yet. Write the title a
searcher would click:

- ✓ `Real tmux in your browser — panes, prefix key, truecolor`
- ✗ `Features | mtmux`

Brand attribution is carried by `og:site_name`, Organization JSON-LD and the visible logo.

Keep titles ≤ 60 characters and descriptions ≤ 155, written as a standalone answer — the
description is what AI search engines quote.

### 8. Every post is part of a cluster, and the build checks it

`src/config/clusters.ts` declares which posts belong to which hub. `src/lib/link-graph.ts` reads
the actual MDX at build time and reports, per post: dangling internal links, self-links, missing
hub/sibling/cross-cluster links, no product-page link, no `docs.mtmux.com` link, fewer than two
off-site citations, and fewer than three inbound links. Nothing else in this codebase can catch a
typo'd slug — it compiles, renders as an anchor, and ships as a soft 404.

The report prints as `[link-graph] …` during `pnpm build`. `SEVERITY` in that file decides whether
it warns or throws, and it is now **`"error"`** — every member of the cluster map exists, so an
orphaned post, a dangling internal link or a missing docs link fails the build. If it throws while
you are adding a post, add the inbound links it names; do not turn it back to `"warn"`.

New marketing → blog links go through `t.rich()` with the `inlineLink()` helper in
`src/lib/rich-links.tsx`. The href must be a **literal string at the call site** — the analyser
reads component source, and a route assembled at runtime is invisible to it.

---

## Layout

```
src/
├── app/
│   ├── layout.tsx              pass-through root (Next requires one)
│   └── [locale]/
│       ├── layout.tsx          document shell: fonts, providers, header, footer
│       ├── page.tsx            home
│       ├── <route>/page.tsx    one directory per marketing page
│       └── blog/               listing, post, tag routes
├── components/
│   ├── ui/                     shadcn primitives — regenerate, don't hand-edit*
│   ├── primitives/             the site's own visual language (see below)
│   ├── site/                   header, footer, switchers, install CTA
│   ├── sections/<page>/        page-specific composed sections
│   └── mdx/                    components available inside blog posts
├── config/site.ts              domain, version, install command, nav structure
├── config/clusters.ts          hub→spoke map for the blog's topic clusters
├── i18n/                       locales, routing, navigation, message loading
└── lib/                        seo, structured-data, blog, link-graph, rich-links, utils
content/blog/<locale>/*.mdx     posts, one directory per language
messages/<locale>/*.json        copy, one file per namespace
```

Note the content path: posts live in **`content/blog/en/`** at the workspace root, not under
`src/`.

\* One deliberate exception: `ui/accordion.tsx` has `aria-hidden="true"` added to its two chevron
icons, which the generated version omits. If you regenerate that component, re-apply it — the
icons are decorative and screen readers should skip them.

### Primitives (`src/components/primitives/`)

Compose pages from these instead of re-inventing spacing and borders:

- `Section`, `SectionHeading`, `Eyebrow`, `Accent` — page rhythm and headings
- `TerminalWindow`, `Line`, `Prompt`, `Tok`, `Cursor` — hand-authored terminal output
- `HairlineGrid`, `HairlineCell`, `FeatureCard`, `StatCard`, `StepCard`, `Keycap`, `Cmd`

Terminal illustrations are markup, not code blocks, so their tokens can carry semantic
colour and their text stays translatable.

---

## Product facts

Keep these consistent across every page — they are load-bearing for trust.

**Verify every claim against source before you write it.** This section was wrong for a long
time and the whole site inherited the errors: it advertised commands that were never implemented,
a notification product that does not exist, a cipher suite we do not use, and three pricing tiers
we do not sell. The three files that settle any question are `apps/cli/src/bin.ts` (what commands
exist), `packages/crypto/src/` (what the crypto is), and `packages/config/src/plans.ts` (what the
plans are). Where they and this file disagree, they win.

- Install is **`npm i -g mtmux`**. This is the _only_ install method shown on the site.
- The version badge is **not** typed here. `next.config.ts` reads it out of `apps/cli/package.json`
  (the package that actually gets published) and inlines it as `NEXT_PUBLIC_MTMUX_VERSION`, which
  `siteConfig.version` reads. Bump the CLI; the site follows.
- Requires **Node 22 or newer and tmux**. macOS, Linux (glibc or musl), WSL2.
- What the product is: one command serves the tmux sessions you already run to any browser **and**
  opens an end-to-end encrypted tunnel, printing a QR and a nine-digit code. No port forwarding,
  no VPN, no SSH key on the phone, no account required.

### The command surface

Exactly what `apps/cli/src/bin.ts` registers, and nothing else:

`mtmux` (alias for `start`) · `start` · `start --local` · `start --no-qr` · `start -n/--name` ·
`start -p/--port` (14100) · `start -h/--host` · `start --no-open` · `start --json` ·
`start --share` (with `--read-only`, `--files`) · `local` · `logs [-n] [-f] [--json]` ·
`pair [code]` · `share [session]` (plus `share list`, `share revoke`, and its
`--read-only`/`--files`/`--expires`/`--label`/`--no-qr` flags) ·
`record [session]` (plus `record list [--json]`, `record stop [id] [--all]`, `record rm <id>`,
`record share <id>`, and its `--pane`/`--title`/`--expires`/`--label`/`--no-qr` flags) ·
`approve` · `status` · `stop` ·
`doctor` · `login`/`logout`/`whoami` · `servers` · `devices [revoke <id>]` · `upgrade` ·
`token print|rotate|set` · `config get [key]` · `config set <key> <value>` · `version` (alias `v`)

Config lives at `~/.mtmux/config.json`, mode 0600. Shares live in
`~/.mtmux/grants.json` (0600) and recordings in `~/.mtmux/recordings/` (0700, files 0600).

There is deliberately **no `mtmux start --record`**. Recording is a command, not a boot mode.

**Do not document `up`, `down`, `watch`, `run`, `notify`, `sessions`, `~/.mtmux/agents.toml`,
`--detach`, `--lan`, `--relay`, `--allow`, `--socket` or `--mux`.** None of them exist.

`share`, `logs`, `approve` and `config get`/`config set` **do** ship — this list said otherwise
for months and the whole site inherited the omission. Settle it against `apps/cli/src/bin.ts`,
never against this file's memory.

The CLI table in `docs-cli-reference.tsx` is **index-matched** against `docs.cli.descriptions` in
`messages/en/docs.json`. Add and remove rows in pairs, or every description shifts silently.

### There is no notification product

No push, no email, no Slack/Discord/ntfy/gotify/webhook routing, no `~/.mtmux/agents.toml`, no
agent presets, no done/blocked/stalled/failed states, no reply-from-notification, no hooks API,
no quiet hours. This holds everywhere — including `/feed.xml`, whose channel description claimed
"agent-aware notifications" until it was moved into `messages/en/blog.json` under `feed.*`. The `signal-*` colour tokens are leftovers from that fiction and now serve as
generic status accents — do not reach for them to describe agent behaviour. The `SignalCard`
primitive that rendered fake notifications has been deleted; don't bring it back.

The honest, adjacent story — which the site does tell — is **pull, not push**: people run long
coding agents in tmux and want to _check on them from a phone_, so mtmux gives them the same pane
in a browser. Never write "notifies you", "pushes you" or "tells you when".

### Crypto (verified against `packages/crypto/src/`)

- Pairing is a **balanced PAKE — CPace over ristretto255**, ciphersuite `CPACE-RISTR255-SHA512`.
- The nine-digit code is a **3-digit routing slot** the broker assigns plus a **6-digit secret**
  generated in the browser. The secret is the PAKE password and **never reaches the broker, not
  even as a hash**. One wrong guess destroys the pairing. Grouping is `492 716 384`, and it comes
  from `codeGroups()` in `packages/crypto/src/pairing-code.ts` — never slice the string yourself.
  The scanned form uses a separate 4-digit slot space; both are settled in that one file.
- Keys come from an **HKDF-SHA256** schedule over the CPace transcript, one per direction.
- Frames are **AES-256-GCM**, per-direction nonces, monotonic counter that rejects replays.
- Reconnecting a known browser is a signed **Ed25519** challenge; revocation is by device id.
- The QR encodes the code in a **URL fragment**, which browsers never send to a server.
- **No independent audit has been performed.** Never imply otherwise.

### Plans and hosts

- Plans live in `packages/config/src/plans.ts`, mirrored for the site in `src/config/plans.ts`.
  Read prices and limits from there — never type a number into a message file.
  Free: 1 server, 3 devices, 5 GB/month relayed, tunnel included, own network unmetered.
  Pro: **$10/month or $100/year**, unlimited servers and devices, 200 GB/month, named servers.
- The payment processor is **Dodo Payments**, not Stripe. There is no SLA and no team plan.
- Real hosts: **`app.mtmux.com`** (web client and dashboard), **`api.mtmux.com`** (pairing
  broker). Self-hosting the broker is real — `MTMUX_API_URL` at runtime, `MTMUX_BUILD_API_URL`
  at build time.
- The whole monorepo is **MIT** licensed, not just the CLI, and it is public at
  `https://github.com/mtmux/mtmux`. There is no source-available tier and no CLA. Container
  images are published to `ghcr.io/mtmux/mtmux-{api,web,relay}`; the broker image is the one a
  self-hoster needs.

### No unsourced numbers

Do not publish a latency, bundle-size, memory or bandwidth figure that nobody measured. Counts a
reader can verify by running the thing ("0 ports to forward", "1 command") are fine.

---

## Common tasks

| Task             | How                                                  |
| ---------------- | ---------------------------------------------------- |
| Add a blog post  | `.claude/skills/add-blog-post`                       |
| Add a language   | `.claude/skills/add-language`                        |
| Add a page       | `.claude/skills/add-page`                            |
| Change the theme | Edit `:root` / `.dark` in `src/app/globals.css` only |
| Deploy           | `.claude/skills/deploy-site`                         |

## Verification

```bash
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm build         # must succeed with pages marked ● (SSG)
```

A page that renders `ƒ (Dynamic)` in the build output has lost static rendering — almost
always a missing `setRequestLocale`.
