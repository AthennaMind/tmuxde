import { promises as fs } from "node:fs";
import path from "node:path";

import { CLUSTERS, clusterOf, productPagesFor } from "@/config/clusters";
import { siteConfig, staticRoutes } from "@/config/site";

import type { Post } from "./blog";

/**
 * Build-time analysis of the site's internal link graph.
 *
 * Nothing else in this codebase can catch a bad link. A typo'd slug in an MDX
 * body compiles, renders as an ordinary anchor, and ships as a soft 404 that
 * nobody notices until Search Console reports it months later. The same is true
 * of the subtler failure: a post nothing links to. It is in the sitemap, it is
 * in the feed, and it will never rank, because a crawler reads internal links
 * as the site's own opinion of what matters and sixteen posts each with two
 * links express no opinion at all.
 *
 * So this module reads the rendered sources — MDX bodies for post→anywhere
 * links, and marketing `.tsx` for page→post links — and asserts the properties
 * the content strategy depends on. It reads the same source the reader sees,
 * for the same reason `extractFaqEntries` does: a graph derived from a
 * hand-maintained list is a graph that drifts.
 *
 * ## A build gate, in the spirit of buildMetadata's length throws
 *
 * `SEVERITY` was `"warn"` while several posts were being written in parallel —
 * a global assertion that throws is exactly wrong then, because a half-finished
 * post breaks a build over a link nobody owns yet. Every member of the cluster
 * map now exists, so it is `"error"`: an orphaned post, a dangling internal
 * link or a missing docs link fails the build rather than shipping as a soft
 * 404 that nothing catches.
 *
 * If you are adding a post and this throws, the fix is to add the inbound links
 * it names — not to turn this back to `"warn"`.
 */

const SEVERITY: "warn" | "error" = "error";

/** Internal links one post may carry before it reads as a link farm. */
const MAX_INTERNAL_LINKS_PER_POST = 20;

/** The floor that kills orphans. Three is the point at which a page is "linked", not "mentioned". */
const MIN_INBOUND_LINKS = 3;

/** Sibling links inside the same cluster. */
const MIN_SIBLING_LINKS = 2;

/** Off-site citations. Research that cites nothing reads as research nobody did. */
const MIN_EXTERNAL_CITATIONS = 2;

export type LinkEdge = {
  /** `blog:<slug>` for a post, `page:<route>` for a marketing page. */
  from: string;
  /** `blog:<slug>` or `page:<route>`. */
  to: string;
};

export type LinkGraphIssue = {
  /** The node the problem belongs to, in the same `blog:`/`page:` form as an edge. */
  node: string;
  code: string;
  message: string;
};

export type LinkGraphReport = {
  edges: LinkEdge[];
  /** Inbound edge count keyed by node id. */
  inbound: Map<string, number>;
  issues: LinkGraphIssue[];
  stats: {
    totalEdges: number;
    blogToBlog: number;
    marketingToBlog: number;
    blogToMarketing: number;
    minInbound: number;
    orphans: number;
    postsWithoutProductLink: number;
    postsWithoutDocsLink: number;
    postsBelowExternalMinimum: number;
    docsLinks: number;
    externalCitations: number;
  };
};

const blogNode = (slug: string) => `blog:${slug}`;
const pageNode = (route: string) => `page:${route}`;

/** `](/foo)` markdown links and `href="/foo"` JSX links, internal and external alike. */
const MARKDOWN_LINK = /\]\(\s*(<?)([^)\s"']+)\1\s*(?:"[^"]*")?\)/g;
const HREF_ATTR = /href=(?:"([^"]+)"|\{`([^`]+)`\}|\{"([^"]+)"\})/g;

function collectLinks(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(MARKDOWN_LINK)) found.push(match[2]);
  for (const match of source.matchAll(HREF_ATTR)) {
    found.push(match[1] ?? match[2] ?? match[3]);
  }
  return found.filter(Boolean);
}

/** Drops the query and fragment: `/compare#ttyd` and `/compare` are the same page. */
function normaliseRoute(href: string): string {
  const withoutHash = href.split("#")[0].split("?")[0];
  if (withoutHash.length > 1 && withoutHash.endsWith("/")) {
    return withoutHash.slice(0, -1);
  }
  return withoutHash === "" ? "/" : withoutHash;
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/** An off-site citation. Our own hosts do not count as research. */
function isOffSiteCitation(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    const host = new URL(href).hostname.toLowerCase();
    return host !== siteConfig.domain && !host.endsWith(`.${siteConfig.domain}`);
  } catch {
    return false;
  }
}

function isDocsSiteLink(href: string): boolean {
  return href.startsWith(siteConfig.docsUrl);
}

/**
 * Which marketing page a component belongs to.
 *
 * `sections/<page>/*` is the site's own convention, and `app/[locale]/<route>`
 * is Next's, so both are readable without a lookup table. Site chrome is
 * excluded on purpose: the footer links to `/blog` from every page, and folding
 * that into inbound counts would report every page as well-linked while telling
 * a crawler nothing.
 */
function ownerRoute(relativePath: string): string | null {
  const unix = relativePath.split(path.sep).join("/");

  if (unix.startsWith("components/site/")) return null;
  if (unix.startsWith("components/blog/")) return null;
  if (unix.startsWith("components/ui/")) return null;

  const section = /^components\/sections\/([^/]+)\//.exec(unix);
  if (section) {
    const dir = section[1];
    if (dir.endsWith(".tsx")) return null;
    return dir === "home" ? "/" : `/${dir}`;
  }
  if (/^components\/sections\/[^/]+\.tsx$/.test(unix)) return null;

  const appPage = /^app\/\[locale\]\/(.*)page\.tsx$/.exec(unix);
  if (appPage) {
    const segments = appPage[1].split("/").filter(Boolean);
    if (segments.some((s) => s.startsWith("["))) return null;
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
  }

  return null;
}

async function walk(dir: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * Every marketing page → post link that exists in component source.
 *
 * These are literal `href="/blog/…"` strings, which is what the `t.rich()` +
 * `Link` pattern already produces — the href lives in the component and only
 * the sentence around it lives in `messages/`. That is also what makes it
 * statically readable here.
 */
async function readMarketingEdges(root: string): Promise<LinkEdge[]> {
  const srcRoot = path.join(root, "src");
  const files = [
    ...(await walk(path.join(srcRoot, "components"))),
    ...(await walk(path.join(srcRoot, "app"))),
  ];

  const edges: LinkEdge[] = [];
  for (const file of files) {
    const owner = ownerRoute(path.relative(srcRoot, file));
    if (!owner) continue;

    const source = await fs.readFile(file, "utf8");
    // Any quoted `/blog/<slug>` literal, not just an `href=` attribute. These
    // hrefs reach `Link` three different ways in this codebase — inline on the
    // element, as an `inlineLink()` argument, and as a value in a lookup map
    // keyed by row or category — and only the first looks like an attribute.
    // Matching the string itself is what makes all three visible.
    for (const match of source.matchAll(/["'`](\/blog\/[a-z0-9-]+)["'`]/g)) {
      const slug = match[1].slice("/blog/".length);
      edges.push({ from: pageNode(owner), to: blogNode(slug) });
    }
  }
  return edges;
}

export async function buildLinkGraph(posts: Post[]): Promise<LinkGraphReport> {
  const root = process.cwd();
  const slugs = new Set(posts.map((post) => post.slug));
  const routes = new Set<string>([
    ...staticRoutes.map((route) => route.href),
    "/blog",
  ]);

  const edges: LinkEdge[] = [];
  const issues: LinkGraphIssue[] = [];
  const seen = new Set<string>();

  const push = (edge: LinkEdge) => {
    const key = `${edge.from}→${edge.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  let docsLinks = 0;
  let externalCitations = 0;
  let postsWithoutProductLink = 0;
  let postsWithoutDocsLink = 0;
  let postsBelowExternalMinimum = 0;

  for (const post of posts) {
    const node = blogNode(post.slug);
    const links = collectLinks(post.body);

    const internal = new Set<string>();
    const external = new Set<string>();

    for (const href of links) {
      if (isExternal(href)) {
        if (isDocsSiteLink(href)) docsLinks += 1;
        if (isOffSiteCitation(href)) external.add(href);
        continue;
      }
      if (!href.startsWith("/")) continue;
      internal.add(normaliseRoute(href));
    }

    externalCitations += external.size;

    let productLinks = 0;
    const productPages = new Set(productPagesFor(post.slug));
    const siblingLinks = new Set<string>();
    let crossClusterLinks = 0;
    let hubLinks = 0;
    const cluster = clusterOf(post.slug);

    for (const route of internal) {
      const targetSlug = /^\/blog\/([a-z0-9-]+)$/.exec(route)?.[1];

      if (targetSlug) {
        if (targetSlug === post.slug) {
          issues.push({
            node,
            code: "self-link",
            message: `links to itself (/blog/${targetSlug})`,
          });
          continue;
        }
        if (!slugs.has(targetSlug)) {
          issues.push({
            node,
            code: "dangling-link",
            message: `links to /blog/${targetSlug}, which does not exist`,
          });
          continue;
        }
        push({ from: node, to: blogNode(targetSlug) });

        const targetCluster = clusterOf(targetSlug);
        if (cluster && targetSlug === cluster.hub) hubLinks += 1;
        else if (cluster && targetCluster?.id === cluster.id) {
          siblingLinks.add(targetSlug);
        } else if (cluster && targetCluster && targetCluster.id !== cluster.id) {
          crossClusterLinks += 1;
        }
        continue;
      }

      if (route.startsWith("/blog/tag/") || route === "/blog") {
        push({ from: node, to: pageNode(route) });
        continue;
      }

      if (!routes.has(route)) {
        issues.push({
          node,
          code: "dangling-link",
          message: `links to ${route}, which is not a route in staticRoutes`,
        });
        continue;
      }

      push({ from: node, to: pageNode(route) });
      if (productPages.has(route)) productLinks += 1;
    }

    if (internal.size > MAX_INTERNAL_LINKS_PER_POST) {
      issues.push({
        node,
        code: "link-budget",
        message: `${internal.size} internal links, over the budget of ${MAX_INTERNAL_LINKS_PER_POST}`,
      });
    }

    if (productLinks === 0) {
      postsWithoutProductLink += 1;
      issues.push({
        node,
        code: "no-product-link",
        message: `no link to a product page (expected one of ${[...productPages].join(", ")})`,
      });
    }

    const docsOnThisPost = links.filter(isDocsSiteLink).length;
    if (docsOnThisPost === 0) {
      postsWithoutDocsLink += 1;
      issues.push({
        node,
        code: "no-docs-link",
        message: `no link to ${siteConfig.docsUrl}`,
      });
    }

    if (external.size < MIN_EXTERNAL_CITATIONS) {
      postsBelowExternalMinimum += 1;
      issues.push({
        node,
        code: "few-citations",
        message: `${external.size} off-site citation(s), below the minimum of ${MIN_EXTERNAL_CITATIONS}`,
      });
    }

    if (cluster) {
      if (cluster.hub !== post.slug && hubLinks === 0 && slugs.has(cluster.hub)) {
        issues.push({
          node,
          code: "no-hub-link",
          message: `does not link up to its cluster hub /blog/${cluster.hub}`,
        });
      }
      if (siblingLinks.size < MIN_SIBLING_LINKS) {
        issues.push({
          node,
          code: "few-siblings",
          message: `${siblingLinks.size} sibling link(s) in cluster "${cluster.id}", below ${MIN_SIBLING_LINKS}`,
        });
      }
      if (crossClusterLinks === 0) {
        issues.push({
          node,
          code: "no-cross-cluster",
          message: `no link out of cluster "${cluster.id}"`,
        });
      }
    } else {
      issues.push({
        node,
        code: "unclustered",
        message: `is not listed in src/config/clusters.ts`,
      });
    }
  }

  for (const edge of await readMarketingEdges(root)) {
    const slug = edge.to.slice("blog:".length);
    if (!slugs.has(slug)) {
      issues.push({
        node: edge.from,
        code: "dangling-link",
        message: `links to /blog/${slug}, which does not exist`,
      });
      continue;
    }
    push(edge);
  }

  const inbound = new Map<string, number>();
  for (const edge of edges) {
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }

  let minInbound = Number.POSITIVE_INFINITY;
  let orphans = 0;
  for (const post of posts) {
    const count = inbound.get(blogNode(post.slug)) ?? 0;
    minInbound = Math.min(minInbound, count);
    if (count === 0) orphans += 1;
    if (count < MIN_INBOUND_LINKS) {
      issues.push({
        node: blogNode(post.slug),
        code: "under-linked",
        message: `${count} inbound link(s), below the minimum of ${MIN_INBOUND_LINKS}`,
      });
    }
  }

  for (const cluster of CLUSTERS) {
    for (const member of [cluster.hub, ...cluster.members]) {
      if (!slugs.has(member)) {
        issues.push({
          node: blogNode(member),
          code: "missing-member",
          message: `cluster "${cluster.id}" lists it, but content/blog has no such post yet`,
        });
      }
    }
  }

  const blogToBlog = edges.filter(
    (e) => e.from.startsWith("blog:") && e.to.startsWith("blog:"),
  ).length;
  const marketingToBlog = edges.filter(
    (e) => e.from.startsWith("page:") && e.to.startsWith("blog:"),
  ).length;
  const blogToMarketing = edges.filter(
    (e) => e.from.startsWith("blog:") && e.to.startsWith("page:"),
  ).length;

  return {
    edges,
    inbound,
    issues,
    stats: {
      totalEdges: edges.length,
      blogToBlog,
      marketingToBlog,
      blogToMarketing,
      minInbound: posts.length === 0 ? 0 : minInbound,
      orphans,
      postsWithoutProductLink,
      postsWithoutDocsLink,
      postsBelowExternalMinimum,
      docsLinks,
      externalCitations,
    },
  };
}

/** Once per process. `getAllPosts` is cached per locale, not per process. */
let asserted = false;

/**
 * Runs the graph checks and reports them. Called once from `getAllPosts`.
 *
 * Failure is never allowed to take the build down for a reason unrelated to
 * linking — a broken `fs` read here would otherwise turn a content build into
 * an outage — so the whole thing is wrapped.
 */
export async function assertLinkGraph(posts: Post[]): Promise<void> {
  if (asserted || posts.length === 0) return;
  asserted = true;

  let report: LinkGraphReport;
  try {
    report = await buildLinkGraph(posts);
  } catch (error) {
    console.warn("[link-graph] analysis failed:", error);
    return;
  }

  const s = report.stats;
  const summary =
    `[link-graph] ${s.totalEdges} edges ` +
    `(${s.blogToBlog} blog→blog, ${s.marketingToBlog} marketing→blog, ${s.blogToMarketing} blog→marketing) · ` +
    `min inbound ${s.minInbound} · orphans ${s.orphans} · ` +
    `no product link ${s.postsWithoutProductLink} · no docs link ${s.postsWithoutDocsLink} · ` +
    `docs links ${s.docsLinks} · off-site citations ${s.externalCitations} · ` +
    `${report.issues.length} issue(s)`;

  if (report.issues.length === 0) {
    console.log(summary);
    return;
  }

  const detail = report.issues
    .map((issue) => `  · ${issue.node} [${issue.code}] ${issue.message}`)
    .join("\n");

  if (SEVERITY === "error") {
    throw new Error(`${summary}\n${detail}`);
  }
  console.warn(`${summary}\n${detail}`);
}
