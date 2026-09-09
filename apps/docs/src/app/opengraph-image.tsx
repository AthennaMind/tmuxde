import { OG_CONTENT_TYPE, OG_SIZE, renderDocsOgCard } from "@/lib/og-card";

export const alt = "mtmux docs — tmux in your browser";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/**
 * The card for the routes in this segment — `/` and the 404.
 *
 * Every docs page has its own card from
 * `app/docs/[[...slug]]/opengraph-image.tsx`; this is the fallback for the two
 * routes that are not docs pages, drawn by the same function so they cannot
 * drift into two different-looking cards.
 *
 * `runtime = "edge"` used to be declared here, which made Next log "Using edge
 * runtime on a page currently disables static generation" and rendered the card
 * on request. It has no reason to be dynamic — the strings are constants.
 */
export default function Image() {
  return renderDocsOgCard({
    title: "mtmux docs",
    description:
      "Install the mtmux CLI, pair a device, and understand the sealed tunnel.",
    path: "/docs",
  });
}
