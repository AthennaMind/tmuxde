---
name: add-doc-page
description: Add or edit a page on the mtmux documentation site (apps/docs → docs.mtmux.com) with correct frontmatter, sidebar placement, internal links, MDX components and SEO surfaces. Use this whenever the user wants a new docs page, a new docs section, a page moved or renamed, or when a docs page is missing from the sidebar, missing from search, or has no inbound links.
---

# Add a page to docs.mtmux.com

The docs site is `apps/docs` — Next.js 16 + Fumadocs 16, content in `content/docs/**.mdx`.
Everything downstream of a page (sidebar, search index, sitemap, `/llms.txt`, `/llms-full.txt`,
its Open Graph card, its canonical, its JSON-LD) is **derived**. You write one MDX file and wire
one line of `meta.json`; nothing else needs editing.

This is not the marketing site. Blog posts and landing pages go through `add-blog-post` /
`add-page` in `apps/site`. Keep the split: **blog = search-entry narrative, docs = reference.**
Same facts, different job — a docs page that opens with a hook and a story is in the wrong repo.

## The two silent failure modes

Learn these before anything else. Neither produces an error, a warning or a failed build.

1. **A file listed in `meta.json` that does not exist yet is silently ignored.** No error, no
   placeholder. This is useful — it lets a navigation restructure land before the content — but
   it also means a typo'd filename in `pages` looks exactly like a page that has not been
   written yet.

2. **A file *not* listed in `meta.json` vanishes from the sidebar but stays routable and stays
   in the sitemap.** So a forgotten entry ships a page that Google will crawl and index and that
   no human can navigate to. It is an orphan by construction. This is the single most likely way
   to get a new page wrong.

After adding a page, prove both: the file is in `pages`, and the page appears in the rendered
sidebar.

## Steps

### 1. Write the MDX file

`content/docs/<slug>.mdx`, or `content/docs/<section>/<slug>.mdx` for a page inside a section.
A section's landing page is `index.mdx` and its URL is the folder (`/docs/agents`).

```mdx
---
title: Sharing a Session
description: Give someone one tmux session without giving them the machine — and what that does and does not mean.
---
```

Only `title` and `description` are needed. The frontmatter is validated by `pageSchema` from
`fumadocs-core/source/schema` (`title`, `description`, `icon`, `full`); an unknown key is
stripped, and a missing `title` fails the build. Do **not** reach for `frontmatterSchema` — it
is deprecated in Fumadocs 16. To add a field, extend `pageSchema` in `source.config.ts`.

`title` and `description` are load-bearing four times over: the `<h1>` and standfirst, the
`<title>` and `<meta name="description">`, the page's Open Graph card, and its line in
`/llms.txt`. Write the description as a sentence a stranger could act on, under ~155 characters.

### 2. List it in `meta.json`

```json
{
  "pages": ["index", "getting-started", "cli"]
}
```

Filenames without the extension, in the order they should appear. The root
`content/docs/meta.json` also uses two other item forms:

| Form | Renders as |
| --- | --- |
| `"---Group name---"` | A section heading in the sidebar |
| `"external:[Label](https://…)"` | A link out, with `target="_blank"` |
| `"..."` | "everything else, alphabetically" — avoid; explicit order is better |

A new **section** needs its own `content/docs/<section>/meta.json` with a `"title"` (the sidebar
group label and the breadcrumb crumb) plus its own `pages`, and the folder name added to the
root `meta.json`.

### 3. Link it, in both directions

The rule the site currently satisfies, and which you should not break:

- **No page has zero inbound links.** A page reachable only from the sidebar is an orphan to a
  crawler.
- **No page has zero outbound links.**
- **Every page ends with a `## Next steps` list** of 3–5 links, each with a short reason —
  `- [Title](/docs/url) — why you'd go there`. All 29 pages have one; keep it that way.

So adding a page is two edits minimum: the new file, and **at least one existing page that links
to it**. Its section's `index.mdx` is the obvious first, but one link from a section index is
weak — add a contextual link from the page whose reader would actually want it.

Check the graph before and after:

```bash
# inbound/outbound per page, orphans and dead ends
node - <<'EOF'
# (see the script in the repo history, or grep for '](/docs' and count)
EOF
grep -rho '](/docs[^)]*)' apps/docs/content/docs | sed 's/#.*//' | sort | uniq -c | sort -n
```

### 4. Use the MDX components

`src/mdx-components.tsx` wires the Fumadocs primitives. They are available in every page with no
import: `Callout`, `Steps` / `Step`, `Cards` / `Card`, `Tabs` / `Tab`, `Files` / `File` /
`Folder`, `Accordion` / `Accordions`, `TypeTable`.

Use them where they earn it, not everywhere:

| Component | Use it for |
| --- | --- |
| `<Callout type="warn">` | A caveat with a security or data consequence. Not for asides |
| `<Callout type="info">` | A design decision worth knowing, e.g. why something is absent |
| `<Steps>` + `<Step title="…">` | A procedure where the order is load-bearing |
| `<Cards>` + `<Card>` | A section index pointing at its children |

Two things happen automatically and are worth knowing:

- **`<Step title="…">` blocks become `HowTo` JSON-LD**, extracted from the page's own compiled
  Markdown at render time. Two or more steps and the schema appears. Because it reads the same
  source the reader sees, it cannot claim a step the page does not show — so never "add steps
  for SEO"; write the procedure or do not.
- **`###` headings on `/docs/troubleshooting` become `FAQPage` JSON-LD** the same way. Phrase
  those headings as the symptom or question a reader would type.

A page whose content is genuinely a reference table gains nothing from being wrapped in chrome.
Most of these pages are prose plus tables, and that is correct.

### 5. Build, and verify what is derived

```bash
pnpm --filter @app/docs build
```

Then serve it on a scratch port — **not** 24102, which production uses, and check that other
agents are not already on the port you pick:

```bash
pnpm --filter @app/docs exec next start --port 14873 --hostname 127.0.0.1
```

```bash
B=http://127.0.0.1:14873
curl -s $B/docs/<your-slug> -o /dev/null -w '%{http_code}\n'
curl -s "$B/api/search?query=<a+word+only+your+page+uses>"   # must be a non-empty array
curl -s $B/docs/<your-slug> | grep -o '<link rel="canonical"[^>]*>'
curl -s -o /dev/null -w '%{content_type}\n' $B/og/<your-slug>   # image/png
curl -s $B/sitemap.xml | grep <your-slug>
curl -s $B/docs/<your-slug> | grep -o 'BreadcrumbList\|TechArticle'
```

The sidebar check that catches failure mode 2:

```bash
curl -s $B/docs | grep -o 'href="/docs/<your-slug>"' | head -1   # empty ⇒ not in meta.json
```

## Moving or renaming a page

The URL is the filename. Renaming a file changes a published URL, so:

1. Rename the file and update `meta.json`.
2. Add a **permanent redirect** in `apps/docs/next.config.ts` under `redirects()` — `permanent:
   true` (308), so crawlers fold the old URL into the new one.
3. Fix every internal link to the old path: `grep -rn '/docs/<old-slug>' apps/docs/content`.

Deleting a published page without a redirect throws away whatever authority it had. There is a
worked example in `next.config.ts`: `/docs/claude-code-remote` → `/docs/agents/claude-code`.

## House rules for the prose

- **Reference register.** State what is, in the order a reader needs it. Tables over paragraphs
  where the content is enumerable. No "let's dive in", no promise-then-payoff structure.
- **Describe what is implemented, not what is intended.** Verify every command and flag against
  `apps/cli/src/bin.ts` and the file in `apps/cli/src/commands/` before writing it. Several
  repo documents have carried stale claims about the CLI surface in both directions.
- **`mtmux` sends no notifications.** Never write a sentence implying it pings, alerts, pushes,
  emails or watches. It has no notification service and no daemon. It is what you open *after*
  something else has paged you. `/docs/agents/notifications` is the page that says so.
- **Do not restate the product entity.** mtmux.com owns the `SoftwareApplication` schema, the
  supported-platform list and the price table. Link to it; a second description here drifts.
- Plan limits and thresholds live only in `packages/config/src/plans.ts`. Do not hardcode a
  number here — link instead.

## What you never have to touch

`sitemap.ts`, `llms.txt/route.ts`, `llms-full.txt/route.ts`, `og/[[...slug]]/route.tsx`,
`api/search/route.ts` and the metadata in `docs/[[...slug]]/page.tsx` are all derived from
`source.getPages()`. Adding an MDX file is the whole job. If you find yourself editing one of
them to make a new page work, something else is wrong.
