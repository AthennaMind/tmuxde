# SEO strategy

The plan this site is built against, and why. Revisit it when adding pages or posts —
publishing something that isn't on this map usually means either the map needs updating or the
post doesn't need writing.

---

## The position we're playing

mtmux is a new domain with no backlink history competing in a niche where the incumbents
(tmate, ttyd, wetty, gotty) are mostly GitHub READMEs with no marketing site at all.

That produces one large, specific opportunity: **almost nobody in this niche owns their own
comparison and alternative queries.** Search "tmate alternative" and you get SaaSHub,
AlternativeTo and LibHunt — aggregators, not products. The tools themselves never wrote the page.
Meanwhile the mature adjacent players (Tailscale, Coder, Warp) show the endgame: real bylined
writing, use-case pages, and fast content cycles tied to each agent-framework release.

So the strategy is two-track:

| Track                    | Purpose                       | Content                                 | Conversion        |
| ------------------------ | ----------------------------- | --------------------------------------- | ----------------- |
| **tmux fundamentals**    | Traffic and topical authority | Reference guides on tmux itself         | Low, deliberately |
| **Agents & comparisons** | Revenue                       | Notification guides, honest comparisons | High              |

The first track earns the right to rank for the second. A new domain writing only bottom-funnel
comparison pages looks like an ad; a domain that owns the tmux reference cluster looks like an
authority that also happens to sell something.

---

## Track 1 — tmux fundamentals

Volumes below are the client's Google Ads Keyword Planner export. Difficulty is **Low** across
this entire cluster, which is unusual for this much volume and is the single best opportunity on
the map.

| Keyword                                                                             | Vol/mo | Target page                 |
| ----------------------------------------------------------------------------------- | ------ | --------------------------- |
| tmux commands / tmux command / tmux basic commands / tmux commands linux            | 880+   | `/blog/tmux-commands`       |
| tmux new session / create tmux session / tmux create new session / tmux new         | 480+   | `/blog/tmux-new-session`    |
| tmux attach session / tmux attach / tmux a / tmux ls / tmux list                    | 390+   | `/blog/tmux-attach-session` |
| tmux for windows / tmux on windows / tmux in windows                                | 390+   | `/blog/tmux-on-windows`     |
| installing tmux / tmux download / tmux ubuntu / debian tmux / tmux centos           | 260+   | `/blog/install-tmux`        |
| mac tmux / tmux on mac / tmux for mac / macos tmux / tmux iterm2                    | 170+   | `/blog/tmux-on-mac`         |
| tmux tutorial / tutorial for beginners / tmux basics / tmux guide / tmux how to use | 90+    | `/blog/tmux-tutorial`       |
| tmux plugins / tpm / tmux resurrect                                                 | 70     | `/blog/tmux-plugins`        |
| tmux ssh / tmux over ssh / tmux broken pipe                                         | 10+    | `/blog/tmux-ssh`            |
| tmux vim / vim tmux navigator                                                       | 10+    | `/blog/tmux-vim`            |

**The head term `tmux` itself (5,400/mo) is not directly targetable** and no page should try. It
is navigational — searchers want the man page or the GitHub repo. It is won, if ever, as a side
effect of owning enough of the cluster around it.

### Why one page per query group

Each post owns a distinct intent and the groups don't overlap. Two pages competing for
"tmux attach" would split link equity and let Google pick the wrong one — the most common
self-inflicted SEO wound, and the reason the `add-blog-post` skill tells you to check for an
existing post before writing a new one.

---

## Track 2 — agents and comparisons

Lower volume, far higher intent, and growing fast because of agentic coding. These are the pages
that convert.

| Cluster                   | Queries                                                                                           | Target                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Claude Code notifications | claude code notifications, get notified when claude code finishes, claude code hooks notification | `/agents`, `/blog/claude-code-notifications` |
| Codex CLI                 | codex cli notification, codex notify hook, codex waiting for approval                             | `/blog/codex-cli-notifications`              |
| Agent monitoring          | ai agent babysitting, monitor ai coding agent, agent finished notification                        | `/blog/stop-babysitting-coding-agents`       |
| tmux in browser           | tmux in browser, tmux web client, web terminal                                                    | `/` , `/blog/tmux-in-browser`                |
| Alternatives              | tmate alternative, ttyd alternative, termius alternative                                          | `/compare`, `/blog/tmate-alternative`        |
| Web terminals             | ttyd vs wetty, wetty alternative, browser ssh, gotty                                              | `/blog/ttyd-vs-wetty`, `/compare`            |
| Mobile                    | tmux from phone, run tmux on iphone, terminal on ipad                                             | `/use-cases`, `/blog/tmux-from-phone`        |

There is live, documented demand here: open issues on `openai/codex` asking for exactly this
notification behaviour, and a scatter of single-purpose OSS tools built to fill the gap. That is
proof of demand without established competition.

---

## Rules the site is built to

**Titles are keyword-first and carry no brand suffix.** Never `Features | mtmux`. Titles are
ranking real estate and a new domain gains nothing from spending characters on a brand nobody
searches for yet. Brand attribution is carried by `og:site_name`, Organization JSON-LD and the
visible logo. Enforced by `buildMetadata` in `src/lib/seo.ts` passing titles through verbatim.

**Descriptions are standalone answers, ≤155 characters.** This string is what AI search engines
quote. "Learn about tmux commands in this guide" wastes the slot.

**Every page opens with a direct answer** in the first two or three sentences, before any
narrative. Roughly half of AI-engine citations come from the first third of a page.

**Comparisons are honest, and lead with what the competitor does best.** `/compare` keeps a
"When not to use mtmux" section. This is not modesty — a comparison page that only flatters us is
worthless for ranking and earns no links. The honesty is the product.

**Comparisons are real `<table>` elements**, never prose. AI Overviews and Perplexity extract
tables far more reliably than sentences, with consistent columns across pages.

**FAQ markup only describes visible Q&A.** `src/lib/mdx.ts` parses `<FAQItem>` out of the same
source the reader sees, so the structured data cannot drift from the page. `extractStepEntries`
does the same for `HowTo` and `<Steps>` — be clear-eyed that Google retired HowTo rich results in
2023, so the payoff is AI-answer extraction, not a SERP feature.

---

## The link graph is part of the strategy, not decoration

Depth alone does not rank a cluster. Two posts on a topic lose to one page that eleven other pages
point at, because internal links are the site's own statement about what matters — and sixteen
posts with two links each state nothing.

`src/config/clusters.ts` declares the hub-and-spoke map; `src/lib/link-graph.ts` checks the actual
MDX against it at build time. The rules it enforces, per post:

| Rule | Why |
| --- | --- |
| Links **up** to its cluster hub | Concentrates authority on the page that answers the broad query |
| ≥ 2 **sibling** links inside its cluster | Makes the cluster legible as a cluster |
| ≥ 1 **cross-cluster** link | Stops each cluster becoming an island |
| ≥ 1 link to a category-matched **product page** | A traffic post with no exit converts nothing |
| ≥ 1 link to `docs.mtmux.com` | Two domains that never link to each other are two weak domains |
| ≥ 2 **off-site citations** | A page that cites nothing reads as unresearched, to a reader and a crawler |
| ≥ 3 **inbound** links | The floor that kills orphans |

`tmux-commands` is the hub with the most inbound links, so it carries a down-link to each of the
nine tmux-fundamentals posts. That single edit is what took the minimum inbound count off zero.

**No prev/next navigation.** This is a reference blog, not a chronological one — date adjacency is
random here, and prev/next spends two anchors per page on the words "Previous" and "Next".
`getRelatedPosts()` scores by shared tags and category, which is the right signal.

---

## The `*mux` brand queries — mostly don't

Search Console shows a scatter of `*mux` brand impressions. Most of them are traps, recorded here
so nobody re-litigates them:

- **`mux pricing` is Mux.com**, the video API company. Different industry, enormous brand, hopeless
  to chase, and an off-topic page would dilute a topically tight domain. Explicitly a bad idea.
- **`muximux`, `modelmux`** — name collisions in unrelated categories. Noise.
- **`opentmux`** — a real project (an OpenCode plugin that opens tmux panes for subagents, ~150
  stars, first published February 2026), but it shares no search intent with remote tmux access.
  The impressions are as likely to be a concatenation of "open tmux". Either way the answer is a
  `## How do you open tmux?` section in `tmux-tutorial` and **zero new pages**.
- **`tmux floax`** is not a brand query at all — floax is a floating-pane plugin, so it belongs in
  `tmux-plugins`. Free win, taken.

And the one that *is* worth building: **`ttyd vs wetty`** — real, on-topic, and adjacent to a recipe
`tmux-in-browser` already carries. Everything else in the landscape (gotty, sshx, zellij) is a row
in `/compare`'s landscape table rather than a page, which picks up the long tail without spending a
thin page per name.

**No `/alternatives/*` pages.** `/compare` is short already; splitting it four ways gives four
~200-word pages, and `tmate-alternative` already owns "tmate alternative". Adding
`/alternatives/tmate` would create a *third* competing URL — precisely the self-inflicted wound
this document warns about two sections up.

---

## Technical foundation (built and verified)

- Per-page `generateMetadata` with self-referencing canonical, bidirectional `hreflang` and
  `x-default`.
- JSON-LD: `Organization` + `WebSite` site-wide; `SoftwareApplication` on home and pricing;
  `BreadcrumbList` everywhere; `FAQPage` where visible Q&A exists; `HowTo` on the docs quickstart
  and on any post that renders a `<Steps>` block; `BlogPosting` per post, with `about`/`mentions`
  and a stable per-author `@id`; `ItemList` on listings.
  **There is deliberately no `SearchAction`** — this document claimed one for months and the code
  was right to omit it. `/blog` honours no `?q=` parameter, so a `SearchAction` would be markup
  describing a capability the user cannot reach. Add it the day search exists, not before.
- `sitemap.xml` with per-locale `xhtml:link` alternate annotations — the most commonly botched
  part of multilingual SEO.
- `/feed.xml` RSS, `/llms.txt` (an index) and `/llms-full.txt` (every post's full text), all three
  generated from the real route and post lists so none of them can drift.
- **A build-time link-graph assertion** (`src/lib/link-graph.ts`, driven by `src/config/clusters.ts`)
  that catches dangling internal links, self-links, orphaned posts, posts with no product link and
  posts with no off-site citation. Nothing else in the codebase can see a typo'd slug: it compiles,
  renders as an ordinary anchor, and ships as a soft 404.
- Per-page and per-post OG images at 1200×630 with copy inside the 1000×524 safe area.
- Every route statically prerendered (`●` in the build output), so LCP is a static file.

## Multilingual

English only today, but the machinery is locale-count agnostic (see `.claude/skills/add-language`).
When it's time, priority order by ROI for a developer CLI tool is **Japanese → German → Spanish →
Portuguese (BR) → Chinese (Simplified)**. Sub-directories (`/ja/…`), never subdomains: a young
domain cannot afford to split its authority.

Translate marketing pages fully; translate only the high-intent posts (the notification and
comparison ones). Developers search technical terms in English regardless of native language, so
translating a tmux reference nobody searches for in translation is wasted effort.

---

## What to do next

1. **Earn links to the comparison pages.** They are the money pages and the ones nobody else owns.
   The honest "when not to use mtmux" framing is what makes them linkable.
2. **Fast-follow each agent release.** When Claude Code, Codex or Gemini CLI changes its hook
   API, update the relevant post the same week. This cluster rewards freshness more than depth.
3. **Add author detail pages** with `Person` schema once there is more than one post per author —
   author-to-entity linkage is close to non-negotiable for AI-Overview citation eligibility.
4. **Watch for cannibalisation** as the blog grows. Before publishing, check whether an existing
   post already targets the query and extend it instead.
