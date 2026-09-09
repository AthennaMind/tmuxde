/**
 * Shared helpers for the `next/og` routes (`[locale]/opengraph-image.tsx` and
 * `[locale]/blog/[slug]/opengraph-image.tsx`).
 *
 * `ImageResponse` (Satori) cannot read CSS custom properties or `oklch()` —
 * every colour has to be a literal `rgb()`/`#hex` string handed to inline
 * styles. Rather than eyeballing hex equivalents of the tokens in
 * `src/app/globals.css` (and letting the two drift apart), `oklchToColor`
 * runs the same OKLab math the browser uses for CSS Color 4 and converts the
 * *exact* dark-scheme values from that file. OG cards always render in the
 * dark scheme — it is "the canonical mtmux look" per that file's own comment
 * — so there is no light-mode branch here.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export const OG_SIZE = { width: 1200, height: 630 } as const;

/** Minimum inset so text survives Slack/iMessage/Twitter crops (centre 1000x524). */
export const OG_SAFE_PADDING = { x: 100, y: 64 } as const;

export const OG_FONT_DISPLAY = "Martian Mono";
export const OG_FONT_MONO = "IBM Plex Mono";

/**
 * OKLCH -> sRGB, via linear-light OKLab (Björn Ottosson's reference matrices,
 * the same ones the CSS Color 4 spec uses). `alpha < 1` returns an
 * `rgba(...)` string instead of a hex string.
 */
export function oklchToColor(
  l: number,
  c: number,
  h: number,
  alpha = 1,
): string {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;

  let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  const toSrgb = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    return clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  };
  r = toSrgb(r);
  g = toSrgb(g);
  bl = toSrgb(bl);

  const toByte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const [rr, gg, bb] = [toByte(r), toByte(g), toByte(bl)];

  if (alpha < 1) return `rgba(${rr}, ${gg}, ${bb}, ${alpha})`;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(rr)}${hex(gg)}${hex(bb)}`;
}

/** `.dark` block values from `src/app/globals.css`, copied verbatim. */
const DARK_TOKENS = {
  surfaceBase: [0.1479, 0.0027, 145.44],
  surfaceRaised: [0.1606, 0.0053, 145.32],
  surfacePanel: [0.1791, 0.0051, 145.36],
  surfaceSunken: [0.138, 0.003, 145.41],
  lineSubtle: [0.2286, 0.0128, 135.12],
  line: [0.2687, 0.0178, 131.28],
  lineStrong: [0.3207, 0.0265, 132.02],
  textStrong: [0.961, 0.0083, 91.48],
  text: [0.9278, 0.0125, 91.52],
  textMuted: [0.7436, 0.0288, 120.69],
  textSubtle: [0.6974, 0.0309, 122.21],
  textFaint: [0.5949, 0.0307, 123.03],
  brand: [0.8627, 0.1721, 132.3],
  brandContrast: [0.1479, 0.0027, 145.44],
  signalDone: [0.8627, 0.1721, 132.3],
  signalBlocked: [0.8123, 0.1263, 76.28],
  signalFailed: [0.6994, 0.1572, 21.96],
} as const satisfies Record<string, readonly [number, number, number]>;

export const OG_COLORS = {
  surfaceBase: oklchToColor(...DARK_TOKENS.surfaceBase),
  surfaceRaised: oklchToColor(...DARK_TOKENS.surfaceRaised),
  surfacePanel: oklchToColor(...DARK_TOKENS.surfacePanel),
  surfaceSunken: oklchToColor(...DARK_TOKENS.surfaceSunken),
  lineSubtle: oklchToColor(...DARK_TOKENS.lineSubtle),
  line: oklchToColor(...DARK_TOKENS.line),
  lineStrong: oklchToColor(...DARK_TOKENS.lineStrong),
  textStrong: oklchToColor(...DARK_TOKENS.textStrong),
  text: oklchToColor(...DARK_TOKENS.text),
  textMuted: oklchToColor(...DARK_TOKENS.textMuted),
  textSubtle: oklchToColor(...DARK_TOKENS.textSubtle),
  textFaint: oklchToColor(...DARK_TOKENS.textFaint),
  brand: oklchToColor(...DARK_TOKENS.brand),
  brandContrast: oklchToColor(...DARK_TOKENS.brandContrast),
  signalDone: oklchToColor(...DARK_TOKENS.signalDone),
  signalBlocked: oklchToColor(...DARK_TOKENS.signalBlocked),
  signalFailed: oklchToColor(...DARK_TOKENS.signalFailed),
  /** `--brand-glow`: brand at 14% alpha, used as a radial wash. */
  brandGlow: oklchToColor(...DARK_TOKENS.brand, 0.16),
  brandGlowSoft: oklchToColor(...DARK_TOKENS.brand, 0.08),
} as const;

type OgFont = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 500 | 600;
  style: "normal";
};

/**
 * Loads the weights the OG cards need: Martian Mono for headings, IBM Plex
 * Mono for terminal chrome and metadata.
 *
 * These are read from `src/assets/fonts/` rather than fetched from
 * `fonts.googleapis.com` at build time. The fetch version claimed to degrade
 * gracefully — it returned `[]` on failure — but Satori throws
 * "No fonts are loaded" when handed an empty array, so the graceful path was
 * a build failure. It is also a build that needs the network, which an
 * offline self-hoster does not have.
 *
 * `.woff`, not `.woff2`: that is the format the font parser bundled with
 * `next/og` reads. See `src/assets/fonts/NOTICE.md`.
 */
const OG_FONT_FILES: Array<{ name: string; weight: 400 | 500 | 600; file: string }> = [
  { name: OG_FONT_DISPLAY, weight: 600, file: "martian-mono-600.woff" },
  { name: OG_FONT_DISPLAY, weight: 500, file: "martian-mono-500.woff" },
  { name: OG_FONT_MONO, weight: 400, file: "ibm-plex-mono-400.woff" },
  { name: OG_FONT_MONO, weight: 500, file: "ibm-plex-mono-500.woff" },
];

export async function loadOgFonts(): Promise<OgFont[]> {
  const dir = path.join(process.cwd(), "src", "assets", "fonts");
  return Promise.all(
    OG_FONT_FILES.map(async ({ name, weight, file }) => {
      const data = await readFile(path.join(dir, file));
      return {
        name,
        weight,
        style: "normal" as const,
        // A Buffer is a view on a pooled ArrayBuffer, so hand Satori the
        // exact bytes rather than the whole pool.
        data: data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ) as ArrayBuffer,
      };
    }),
  );
}

/**
 * Truncates a post title around `max` characters without cutting a word in
 * half, so the blog OG card never clips mid-word.
 */
export function truncateTitle(title: string, max = 90): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : max)}…`;
}
