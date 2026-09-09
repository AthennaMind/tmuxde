import { getTranslations } from "next-intl/server";
import { ImageResponse } from "next/og";

import { siteConfig } from "@/config/site";
import {
  loadOgFonts,
  OG_COLORS,
  OG_FONT_DISPLAY,
  OG_FONT_MONO,
  OG_SAFE_PADDING,
  OG_SIZE,
  truncateTitle,
} from "@/lib/og";

/**
 * The card every page shares apart from the home page and the blog posts,
 * which have hand-tuned cards of their own.
 *
 * `buildMetadata` has always pointed `og:image` at `<route>/opengraph-image`,
 * but only those two routes were ever built — so /features, /pricing,
 * /security, /faq, every tag page and the rest advertised an image that 404s,
 * and every share of them rendered as a bare grey link. The fix is to make the
 * route exist everywhere rather than to give 38 pages one identical fallback:
 * each `opengraph-image.tsx` below is a few lines of Next metadata-file
 * boilerplate naming its message namespace, and the drawing lives here once.
 *
 * Same constraints as `og.ts`: Satori, no CSS variables, literal colours only.
 */

/** The two-pane split from `logo-mark.svg`, redrawn as flex boxes for Satori. */
function MarkGlyph() {
  return (
    <div
      style={{
        display: "flex",
        width: 56,
        height: 56,
        borderRadius: 13,
        backgroundColor: OG_COLORS.brand,
        padding: 8,
        gap: 5,
      }}
    >
      <div
        style={{
          display: "flex",
          width: "44%",
          height: "100%",
          borderRadius: 4,
          backgroundColor: OG_COLORS.brandContrast,
        }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "56%",
          height: "100%",
          gap: 5,
        }}
      >
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "47%",
            borderRadius: 4,
            backgroundColor: OG_COLORS.brandContrast,
          }}
        />
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "47%",
            borderRadius: 4,
            backgroundColor: OG_COLORS.brandContrast,
            opacity: 0.45,
          }}
        />
      </div>
    </div>
  );
}

/**
 * Draws the card from strings the caller already has. Exported for the tag
 * pages, whose title is interpolated rather than read straight from a
 * namespace.
 */
export async function renderOgCard({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  /** Locale-independent route, rendered as the card's footer address. */
  path: string;
}) {
  const fonts = await loadOgFonts();

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: OG_COLORS.surfaceBase,
        backgroundImage: `radial-gradient(ellipse 900px 560px at 18% 20%, ${OG_COLORS.brandGlow}, transparent 70%)`,
        padding: `${OG_SAFE_PADDING.y}px ${OG_SAFE_PADDING.x}px`,
      }}
    >
      {/* Header: mark + wordmark */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <MarkGlyph />
        <span
          style={{
            fontFamily: OG_FONT_DISPLAY,
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: -1.2,
            color: OG_COLORS.textStrong,
          }}
        >
          {siteConfig.name}
        </span>
      </div>

      {/* The page's own title and description — the whole point of the card. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: "auto",
          maxWidth: 940,
        }}
      >
        <h1
          style={{
            fontFamily: OG_FONT_DISPLAY,
            fontSize: 52,
            fontWeight: 600,
            lineHeight: 1.14,
            letterSpacing: -1.6,
            color: OG_COLORS.textStrong,
            margin: 0,
          }}
        >
          {truncateTitle(title, 72)}
        </h1>
        <p
          style={{
            fontFamily: OG_FONT_MONO,
            fontSize: 22,
            fontWeight: 400,
            lineHeight: 1.5,
            color: OG_COLORS.textMuted,
            marginTop: 20,
            marginBottom: 0,
            maxWidth: 860,
          }}
        >
          {/* Above the 155 `buildMetadata` enforces, so a description that
              honours the contract always renders whole and only a rogue one
              is ever clipped. */}
          {truncateTitle(description, 160)}
        </p>
      </div>

      {/* Footer: the address this card links to. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginTop: "auto",
          paddingTop: 26,
          borderTop: `1px solid ${OG_COLORS.line}`,
          fontFamily: OG_FONT_MONO,
          fontSize: 22,
        }}
      >
        <span style={{ display: "flex", color: OG_COLORS.brand }}>
          {siteConfig.domain}
        </span>
        <span style={{ display: "flex", color: OG_COLORS.textMuted }}>
          {path}
        </span>
      </div>
    </div>,
    { ...OG_SIZE, fonts },
  );
}

/**
 * The usual case: a page whose `meta.title` and `meta.description` already sit
 * in `messages/<locale>/<namespace>.json` — the same two strings the page
 * hands to `buildMetadata`, so the card and the search result never disagree.
 */
export async function renderPageOgCard({
  locale,
  namespace,
  path,
}: {
  locale: string;
  /** Message namespace, e.g. `"features"` or `"legal.privacy"`. */
  namespace: string;
  path: string;
}) {
  const t = await getTranslations({ locale, namespace });

  return renderOgCard({
    title: t("meta.title"),
    description: t("meta.description"),
    path,
  });
}
