import { permanentRedirect } from "next/navigation";

/**
 * This site is documentation only.
 *
 * The marketing landing page lives at mtmux.com (`apps/site`). A second one
 * here would compete with it for the same search terms and drift out of sync,
 * so `/` sends people straight into the docs tree.
 *
 * Permanent (308) rather than `redirect`'s temporary 307: this is the shape of
 * the site, not a migration we intend to undo, and a 308 lets crawlers fold the
 * root's authority into `/docs` instead of re-checking it forever.
 */
export default function RootPage() {
  permanentRedirect("/docs");
}
