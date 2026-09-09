---
name: add-blog-post
description: Write and publish a new MDX blog post on the mtmux site, with correct frontmatter, SEO-targeted title and description, structured data and internal links. Use this whenever the user wants to add, write, draft or publish a blog post, article, guide, tutorial or comparison page on this site — including when they only say "write a post about X", "we should cover Y", or hand over a keyword to target.
---

# Add a blog post

A post is one MDX file. Everything else — routing, the listing page, tags, RSS, the sitemap,
the OG image, structured data, reading time, the table of contents — is derived from it
automatically. So the whole job is: pick the right target, write the file, verify the build.

## 1. Decide what the post is actually for

Before writing, be able to answer: **which search query does this post win, and what does the
reader do next?** A post without a target query is a diary entry — it will not rank and it will
not convert.

Two clusters matter on this site, and they are written differently:

| Cluster              | Example queries                                        | Goal                                   | Voice                                                 |
| -------------------- | ------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------- |
| tmux fundamentals    | "tmux commands", "tmux new session", "installing tmux" | Traffic. High volume, low difficulty.  | Pure reference. Barely mention mtmux.                 |
| Agents & comparisons | "run claude code unattended", "tmate alternative"      | Conversion. Lower volume, high intent. | Honest comparison; mtmux is one option among several. |

Check `content/blog/en/` first — if a post already covers the query, extend it instead of
publishing a near-duplicate. Two pages competing for one query is the most common self-inflicted
SEO wound.

## 2. Create the file

Path: `content/blog/<locale>/<slug>.mdx`. The filename **is** the URL — `tmux-commands.mdx`
serves at `/blog/tmux-commands`. Use the target keyword as the slug, hyphenated, no dates, no
stop words.

Frontmatter is validated by a zod schema in `src/lib/blog.ts`. A mistake fails the build with the
file and field named, which is deliberate — a post that publishes with a missing description is
worse than a post that does not publish.

```yaml
---
title: "tmux commands: the cheat sheet you'll actually remember"
description: "The tmux commands worth memorising, grouped by what you are trying to do: sessions, windows, panes, copy mode and scripting."
date: "2026-07-14"
updated: "2026-07-26" # optional
author: "ivo-hart" # key from src/config/authors.ts
category: "tmux" # tmux | agents | comparisons | mobile | security
icon: "🍎" # optional emoji for the generated cover
howTo: false # set true only if the post is a real procedure (see below)
tags: ["tmux", "cheat sheet", "cli"]
keywords: ["tmux commands", "tmux command", "tmux cheat sheet"]
featured: false
draft: false
---
```

**Title** — keyword-first, ≤ 60 characters, and never with a `| mtmux` suffix. Titles are ranking
real estate; spending eight characters on a brand nobody searches for yet is a straight loss.
Write the title a searcher would click.

**Description** — ≤ 155 characters, phrased as a complete standalone answer. This is the string
AI search engines quote verbatim, so "Learn about tmux commands in this guide" wastes the slot
while "The tmux commands worth memorising, grouped by what you're trying to do" earns it.

**author** — must be a key in `src/config/authors.ts`. Real bylines linked to a profile are an
E-E-A-T signal; add a new author there rather than inventing one inline.

**icon** — optional. Covers are generated in code, never sourced as images: the category picks a
glyph and the slug picks one of three light positions, so a grid of cards varies without anyone
commissioning artwork. Set `icon` only when the category default is too generic to be useful —
🍎 on the macOS post earns its place, a 💻 on a tmux post does not. Leaving it off is the norm.

## 3. Write it

Read `content/blog/en/tmux-commands.mdx` first. It is the reference for voice, density and
component use — matching it is faster than inventing a new structure.

The rules that matter:

- **Open with a direct answer in the first two or three sentences**, before any narrative.
  Roughly half of AI-engine citations are pulled from the first third of a page, so the money
  sentence goes first, not after a scene-setting anecdote.
- **Engineer explaining to another engineer.** No "in today's fast-paced world", no listicle
  padding, no exclamation marks.
- **Be honest about limits**, including when a competing tool is the better answer. A comparison
  post that only flatters us is worthless for both ranking and trust — the honesty is precisely
  what earns links.
- **Mention mtmux at most twice**, plus one closing paragraph, and only where it genuinely
  answers the question on the page. A post that never needs it should never mention it.
- The only install command that may appear anywhere is `npm i -g mtmux`.
- Use question-form `##` headings that mirror real queries. They feed the table of contents and
  get cited more often than noun-phrase headings.
- 1200–2000 words. Include at least one table or terminal demo, and an `<FAQ>` block.

Never invent a flag, an option or a competitor's pricing. If a detail is uncertain, verify it or
write around it — one wrong flag discredits the whole page.

**The mtmux command surface is exactly `apps/cli/src/bin.ts`.** If a command is not registered in
that file it does not exist, however plausible it sounds. The genuinely absent set is `up`, `down`,
`watch`, `run`, `notify`, `sessions` and `~/.mtmux/agents.toml`.

`share` (and `share list` / `share revoke`), `logs`, `approve` and `config get` / `config set`
**do** ship. This skill listed `share` as never-shipped for months, which is why no post mentions
a feature the CLI has had all along — open `apps/cli/src/bin.ts` and read it rather than trusting
any prose, including this paragraph.

**mtmux sends no notifications.** No push, no Slack, no webhooks, no agent detection, no
done/blocked/stalled/failed states. Posts about running agents unattended must stay on the honest
framing: _you open the session from a phone and look at it_ — pull, not push. If a post needs a
paging story, point at a tmux hook into ntfy and be clear that is a separate tool.

## 4. Components available inside a post

These are injected automatically. Posts never import anything.

```mdx
<Callout type="note|tip|warning|danger" title="...">
  …
</Callout>
<Steps>
  <Step title="...">…</Step>
</Steps>
<TerminalDemo title="~/repo — tmux">
  $ tmux new -s work ← a line starting "$ " renders a prompt # a comment ← a
  line starting "#" renders dimmed
</TerminalDemo>
<CompareTable
  columns={["Tool", "Mobile UI"]}
  rows={[
    ["mtmux", "Yes"],
    ["tmate", "No"],
  ]}
/>
<KeyRow keys={["⌃b", "esc", "tab"]} active="⌃b" />
<FAQ>
  <FAQItem q="Real question?">Answer.</FAQItem>
</FAQ>
<Cmd>tmux attach</Cmd>
<Figure caption="…">…</Figure>
```

Fenced code blocks take a title and line highlighting: ` ```bash title="~/.tmux.conf" {2-3} `.

Use `##` and `###` only — the `#` is rendered from the frontmatter title, and a second `h1`
breaks the heading outline.

The `<FAQ>` block is not decoration: `src/lib/mdx.ts` parses `<FAQItem q="…">` out of the raw
source to emit FAQPage structured data. Because it reads the same source the reader sees, the
markup can never claim a question the page does not actually show — which is what Google
penalises. Only write questions people genuinely ask.

## 5. Link it into the site

A post with no inbound or outbound links is invisible to crawlers and to readers. This is not a
style preference — `src/lib/link-graph.ts` checks every rule below against the actual MDX during
`pnpm build` and prints a `[link-graph]` report naming any post that fails.

First, **add the slug to `src/config/clusters.ts`** under the right hub. A post with no cluster is
reported as `unclustered`, and the map is allowed to name slugs that do not exist yet — that is how
a cluster's shape gets agreed before all of it is written.

Then, in the body:

- **Link up to your cluster's hub** once. `tmux-commands` for tmux fundamentals,
  `coding-agent-notifications` for the agent cluster, `tmux-in-browser` for remote access.
- **Link sideways to ≥ 2 siblings** in the same cluster, with plain markdown links to `/blog/<slug>`.
- **Link out of your cluster** at least once. Clusters that never reference each other are islands.
- **Link to one product page**, category-matched: `/docs`, `/features` or `/use-cases` for tmux
  posts; `/agents` or `/use-cases` for agent posts; `/compare`, `/security` or `/pricing` for
  comparisons.
- **Link to `docs.mtmux.com`** once, at a path that actually exists (`/getting-started`, `/cli`,
  `/pairing`, `/sealed-tunnel`, `/self-hosting`, `/sharing`, `/troubleshooting`, `/web-app/*`, …).
  Two domains that never link to each other are two weak domains.
- **Cite ≥ 2 off-site authoritative sources** — the tmux manual, a project's own README, an
  advisory. Research that cites nothing reads as research nobody did, to a reader and a crawler
  alike. Verify a URL resolves before you publish it.
- **Get ≥ 3 inbound links**: add a link to your new post from at least three existing pages. The
  hub is the obvious first one. This is the rule that kills orphans, and it is the one people skip.
- Reuse existing tags where they fit (check `getAllTags` output or just read the other posts).
  Inventing a one-post tag creates a dead-end archive page.
- Keep the total under 20 internal links. Past that it stops being navigation.

Marketing pages link into the blog through `t.rich()` with `inlineLink()` from
`src/lib/rich-links.tsx`, wrapping a `<post>…</post>` tag in the message file. The href goes at the
call site as a literal string, never in `messages/`. **If the page's copy also feeds JSON-LD**
(`/faq` does), the tag name must be added to that page's tag-stripping regex, or raw markup ships
inside the structured data.

## 6. Verify

```bash
pnpm build
```

The post must appear in the build output under `/[locale]/blog/[slug]`. Then confirm:

- The title renders in the listing and the reading time looks sane.
- The table of contents matches the `##`/`###` headings.
- `/feed.xml`, `/sitemap.xml`, `/llms.txt` and `/llms-full.txt` include the new URL.
- The `[link-graph]` line in the build output does not name your slug. A `dangling-link` there is
  a soft 404 you were about to ship.

`howTo: true` in the frontmatter emits `HowTo` structured data, with the steps read out of the
post's first `<Steps>` block by `extractStepEntries`. Both halves are required, and each catches a
different lie: the `<Steps>` block means the markup can never describe a sequence the reader cannot
see, and the flag means a `<Steps>` block used as a *list* ("the ten commands worth memorising")
does not get labelled a procedure. Set it only when the post genuinely walks someone through doing
a thing. Be clear-eyed about the payoff: Google retired HowTo rich results in 2023, so this buys
AI-answer extraction, not a SERP feature.

If the build fails on frontmatter, the error names the file and the offending field — fix that
field rather than loosening the schema.

## Adding a post in another language

Same slug, different directory: `content/blog/de/tmux-commands.mdx`. The slug must match the
English original so the hreflang alternates line up. A locale with no translation for a given
slug automatically falls back to the English post and shows an "not translated yet" notice, so a
partially translated blog never 404s — see `.claude/skills/add-language`.
