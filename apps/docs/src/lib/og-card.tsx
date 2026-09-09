import { ImageResponse } from "next/og";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

/**
 * Satori cannot read CSS custom properties or `oklch()`, so these are the sRGB
 * conversions of the dark-scheme tokens the marketing site's cards use — the
 * values `apps/site/src/lib/og.ts` computes from its `globals.css` at build
 * time. That app owns the conversion; this is a different package and copies
 * the five colours it needs rather than reaching across the workspace.
 */
export const OG_COLORS = {
  /** `--surface-base` — oklch(0.1479 0.0027 145.44). */
  surfaceBase: "#0a0b0a",
  /** `--surface-panel` — oklch(0.1791 0.0051 145.36). */
  surfacePanel: "#101210",
  /** `--line` — oklch(0.2687 0.0178 131.28). */
  line: "#2a3122",
  /** `--brand` — oklch(0.8627 0.1721 132.3). */
  brand: "#a6e96b",
  /** `--text-strong` — oklch(0.961 0.0083 91.48). */
  textStrong: "#f4f2ec",
  /** `--text-muted` — oklch(0.7436 0.0288 120.69). */
  textMuted: "#a9af9b",
} as const;

/** Keeps a long title from pushing the description off the card. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The card every docs page gets.
 *
 * All 22 pages previously shared one static card reading "tmux in your
 * browser." — so a link to the protocol reference and a link to the
 * troubleshooting page were visually identical in Slack, and the preview told a
 * reader nothing about which one they were about to open. This draws the page's
 * own title, its own description and its own path.
 *
 * No custom fonts: `ImageResponse` ships a default sans face, and fetching a
 * Google font at build time makes every one of 30 cards depend on the network.
 * The marketing site does load its brand fonts, because its cards are shared
 * far more often; a docs card is read, not admired.
 */
export function renderDocsOgCard({
  title,
  description,
  path,
  eyebrow,
}: {
  title: string;
  description?: string;
  /** The page's own route, drawn in the footer as its address. */
  path: string;
  /** Section name, e.g. "Agents" — omitted for top-level pages. */
  eyebrow?: string;
}) {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          padding: "64px 80px",
          background: `linear-gradient(135deg, ${OG_COLORS.surfaceBase} 0%, ${OG_COLORS.surfacePanel} 60%, ${OG_COLORS.surfaceBase} 100%)`,
          color: OG_COLORS.textStrong,
          fontFamily: "system-ui",
        }}
      >
        {/* Header: the mark, the wordmark, and which section this page is in. */}
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: OG_COLORS.brand,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 34,
              fontWeight: 700,
              color: OG_COLORS.surfaceBase,
            }}
          >
            ›
          </div>
          <div style={{ display: "flex", fontSize: 34, fontWeight: 700 }}>
            mtmux docs
          </div>
          {eyebrow ? (
            <div
              style={{
                display: "flex",
                marginLeft: 8,
                padding: "6px 16px",
                borderRadius: 999,
                border: `1px solid ${OG_COLORS.line}`,
                fontSize: 22,
                color: OG_COLORS.textMuted,
              }}
            >
              {eyebrow}
            </div>
          ) : null}
        </div>

        {/* The page's own title and description — the whole point of the card. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: "auto",
            maxWidth: 960,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 64,
              fontWeight: 700,
              letterSpacing: -1.8,
              lineHeight: 1.1,
              color: OG_COLORS.textStrong,
            }}
          >
            {truncate(title, 68)}
          </div>
          {description ? (
            <div
              style={{
                display: "flex",
                marginTop: 22,
                fontSize: 26,
                lineHeight: 1.45,
                color: OG_COLORS.textMuted,
                maxWidth: 900,
              }}
            >
              {truncate(description, 150)}
            </div>
          ) : null}
        </div>

        {/* Footer: the address this card links to. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginTop: "auto",
            paddingTop: 28,
            borderTop: `1px solid ${OG_COLORS.line}`,
            fontSize: 22,
          }}
        >
          <div style={{ display: "flex", color: OG_COLORS.brand }}>
            docs.mtmux.com
          </div>
          <div style={{ display: "flex", color: OG_COLORS.textMuted }}>
            {path}
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}
