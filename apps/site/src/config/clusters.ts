/**
 * The blog's topic clusters, declared rather than inferred.
 *
 * A search cluster is a hub post that answers the broad query and a set of
 * spokes that each answer one narrow one. The value is not the taxonomy — it is
 * that every spoke links *up* to its hub, so the hub accumulates the internal
 * authority instead of sixteen posts sharing it evenly and none of them ranking.
 *
 * This map is the input to `src/lib/link-graph.ts`, which checks the actual MDX
 * against it at build time. It deliberately lists slugs that are not written
 * yet: a cluster you can see the shape of is a cluster you can finish, and the
 * assertion reports a missing member rather than silently believing the cluster
 * is complete. `assertLinkGraph` skips checks for members with no file.
 *
 * Categories in `frontmatterSchema` are for the reader (they colour cards and
 * name the archive). Clusters are for the crawler. They are not the same axis
 * and should not be collapsed into one.
 */

export type ClusterId = "tmux" | "agents" | "remote";

export type Cluster = {
  id: ClusterId;
  /** Human label, used in reporting only — never rendered. */
  label: string;
  /** The post every member links up to. Also a member of its own cluster. */
  hub: string;
  /** Spokes, hub excluded. May name slugs that do not exist yet. */
  members: readonly string[];
  /**
   * The marketing page this cluster converts to. Every post in the cluster is
   * expected to link here at least once — eight of sixteen posts had no product
   * link at all, which is a traffic cluster with no exit.
   */
  productPage: string;
  /** Extra marketing routes that are also acceptable as the product link. */
  alsoProductPages: readonly string[];
};

export const CLUSTERS: readonly Cluster[] = [
  {
    id: "tmux",
    label: "tmux fundamentals",
    hub: "tmux-commands",
    members: [
      "tmux-new-session",
      "tmux-attach-session",
      "tmux-tutorial",
      "install-tmux",
      "tmux-on-mac",
      "tmux-on-windows",
      "tmux-plugins",
      "tmux-ssh",
      "tmux-vim",
    ],
    productPage: "/docs",
    alsoProductPages: ["/features", "/use-cases"],
  },
  {
    id: "agents",
    label: "coding agents and notifications",
    hub: "coding-agent-notifications",
    members: [
      "claude-code-notifications",
      "codex-cli-notifications",
      "stop-babysitting-coding-agents",
      "tmux-notifications",
      "claude-code-sound-when-done",
      "terminal-notifications",
      // Deliberately absent: `claude-code-vscode-notifications`. The page was
      // gated on the VS Code extension having a notification surface of its
      // own, and it does not — the request for `claude-code.notifications.
      // enabled` is an open, unanswered feature request, and the extension's
      // only attention signal today is a coloured dot on the editor tab.
      // `agentPushNotifEnabled` belongs to Remote Control, not the extension.
      // A page about a setting that does not exist is a page that gets
      // corrected by its own comments.
    ],
    productPage: "/agents",
    alsoProductPages: ["/use-cases", "/features"],
  },
  {
    id: "remote",
    label: "reaching a terminal from elsewhere",
    hub: "tmux-in-browser",
    members: ["tmate-alternative", "ttyd-vs-wetty", "tmux-from-phone"],
    productPage: "/compare",
    alsoProductPages: ["/features", "/security", "/use-cases", "/pricing"],
  },
];

/** Every slug the cluster map knows about, hubs included. */
export const CLUSTERED_SLUGS: readonly string[] = CLUSTERS.flatMap(
  (cluster) => [cluster.hub, ...cluster.members],
);

/** The cluster a slug belongs to, or `undefined` if it has not been assigned one. */
export function clusterOf(slug: string): Cluster | undefined {
  return CLUSTERS.find(
    (cluster) => cluster.hub === slug || cluster.members.includes(slug),
  );
}

/** Sibling slugs in the same cluster, excluding `slug` and its hub. */
export function siblingsOf(slug: string): readonly string[] {
  const cluster = clusterOf(slug);
  if (!cluster) return [];
  return cluster.members.filter((member) => member !== slug);
}

/** Marketing routes that count as this post's product link. */
export function productPagesFor(slug: string): readonly string[] {
  const cluster = clusterOf(slug);
  if (!cluster) return ["/features", "/docs", "/agents", "/compare"];
  return [cluster.productPage, ...cluster.alsoProductPages];
}
