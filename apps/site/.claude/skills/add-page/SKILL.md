---
name: add-page
description: Add a new marketing or content page to the mtmux Next.js site with correct static rendering, metadata, hreflang, structured data, translations and navigation wiring. Use this whenever the user wants a new page, route, landing page, or section on the site — including "we need a page for X", "add an alternatives page", or when a page exists but is missing SEO metadata or has lost static rendering.
---

# Add a page

Every page on this site is statically rendered per locale, keyword-targeted, fully translated and
composed from shared primitives. The checklist below is short, but each item is load-bearing —
skipping one silently costs either the static HTML or the search ranking.

## 1. Route

Create `src/app/[locale]/<route>/page.tsx`. The directory name is the URL. Keep it short,
hyphenated and keyword-shaped (`/use-cases`, not `/whyMtmux`).

## 2. The page component

```tsx
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, graph } from "@/lib/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "myPage" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/my-page",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function MyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale); // ← without this the route goes dynamic
  const t = await getTranslations("myPage");

  return (
    <>
      <JsonLd
        json={graph(
          breadcrumbSchema(locale as Locale, [
            { name: t("breadcrumb.home"), href: "/" },
            { name: t("breadcrumb.current"), href: "/my-page" },
          ]),
        )}
      />
      {/* sections */}
    </>
  );
}
```

Three things in there are easy to get wrong:

- **`params` is a Promise.** Next 16 removed the synchronous fallback, so it must be awaited.
- **`setRequestLocale(locale)` must run before any translation call.** Omit it and the route
  quietly becomes dynamic — the build marks it `ƒ` instead of `●` and you lose the static HTML.
- **`buildMetadata` is not optional.** It generates the canonical URL, the bidirectional hreflang
  set, `x-default`, Open Graph and the Twitter card. Hand-rolling `export const metadata` skips
  all of it.

## 2b. The share card

`buildMetadata` points `og:image` at `<route>/opengraph-image`, so the route needs one or the
page shares as a bare grey link. Copy any neighbour's — they are four constants and a call to
`renderPageOgCard` from `src/lib/og-page.tsx` with this page's message namespace:

```tsx
// src/app/[locale]/my-page/opengraph-image.tsx
export default async function Image({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return renderPageOgCard({ locale, namespace: "myPage", path: "/my-page" });
}
```

## 3. Title and description

Keyword-first, and **never** a `| mtmux` suffix. Titles are ranking real estate, and a new domain
gains nothing from spending characters on a brand nobody searches for yet. Brand attribution is
already carried by `og:site_name`, the Organization JSON-LD and the visible logo.

- ✓ `Real tmux in the browser — prefix key, panes, truecolor`
- ✗ `Features | mtmux`

Keep titles ≤ 60 characters and descriptions ≤ 155, with the description written as a complete
standalone answer — that string is what AI search engines quote.

## 4. Copy goes in a message file

Create `messages/en/<namespace>.json`. The file name is the namespace, so
`messages/en/pricing.json` is read with `getTranslations("pricing")`.

No literal English in components — including `alt` text, `aria-label`s and visually hidden
strings, which are read by screen readers and indexed by search engines.

Give every page a `meta.title`, `meta.description` and `breadcrumb.*` at minimum.

## 5. Compose from primitives

Build the page out of small section components in `src/components/sections/<page>/`, not one
long file. Reach for the existing primitives rather than re-inventing spacing and borders:

- `Section`, `SectionHeading`, `Eyebrow`, `Accent` — rhythm and headings
- `TerminalWindow`, `Line`, `Prompt`, `Tok`, `Cursor` — hand-authored terminal output
- `HairlineGrid`, `HairlineCell`, `FeatureCard`, `StatCard`, `StepCard`, `Keycap`, `Cmd`

Alternate `Section` tone between `base` and `raised` down the page — that banding is what gives
the site its vertical rhythm, so pages should not set their own backgrounds.

**No hardcoded colours.** A hex code, an `oklch(...)` or a stock Tailwind colour (`text-zinc-400`)
in a `.tsx` file is a bug. Use the semantic tokens; they flip between light and dark
automatically, which is why almost no component needs a `dark:` variant.

Import `Link` from `@/i18n/navigation`, never from `next/link` — the latter breaks every
non-default locale.

## 6. Wire it into navigation

- Header and footer links live in `src/config/site.ts` (`navigation`, `footerNavigation`).
- Add the route to `staticRoutes` in the same file so it enters the sitemap with a sensible
  `changeFrequency` and `priority`.
- Link to it from at least one related page. An orphan page is crawled late and ranks poorly.

## 7. Structured data

Emit only what the page genuinely contains — markup describing content the user cannot see is a
violation, and AI engines weight structured data heavily enough that getting it wrong is costly.

| Page has                       | Emit                                                 |
| ------------------------------ | ---------------------------------------------------- |
| Any non-home page              | `breadcrumbSchema`                                   |
| Visible Q&A                    | `faqSchema` — covering exactly the visible questions |
| Genuine numbered steps         | `howToSchema`                                        |
| Pricing or product detail      | `softwareApplicationSchema`                          |
| A list of comparisons or items | `itemListSchema`                                     |

## 8. Verify

```bash
pnpm typecheck && pnpm lint && pnpm build
```

In the build output the new route must show `●` (SSG) with a line per locale. A `ƒ (Dynamic)`
means static rendering was lost — almost always a missing `setRequestLocale`.

Then spot-check the rendered head:

```bash
# Port 41999, not 41317 — PM2 already holds 41317 with the live site.
pnpm exec next start --port 41999
curl -s localhost:41999/my-page | grep -E '<title>|canonical|hreflang'
```

Confirm the title has no brand suffix, the canonical is self-referencing, and one `hreflang` line
exists per locale plus `x-default`.
