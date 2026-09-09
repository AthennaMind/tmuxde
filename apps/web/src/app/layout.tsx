import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Martian_Mono } from "next/font/google";
import { ThemeProvider } from "@repo/ui/providers/theme-provider";
import { ToastProvider } from "@repo/ui/providers/toast-provider";
import { PwaProvider } from "@/components/pwa/pwa-provider";
import "./globals.css";

/*
 * The same three faces the marketing site uses, replacing Inter + JetBrains
 * Mono. Someone who arrives from mtmux.com should not feel they have landed on
 * a different product.
 *
 * The variable names matter: `globals.css` maps `--font-plex-sans` and friends
 * into `--font-sans`/`--font-mono`/`--font-display`. Naming a face
 * `--font-mono` directly — as the old JetBrains declaration did — sets that
 * variable on <body> and silently overrides the whole @theme mapping.
 */

/** Display face: geometric monospace, headings only. */
const martianMono = Martian_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-martian-mono",
  display: "swap",
});

/** Reading face: UI labels and prose. */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

/** Terminal face: code, shell output, keycaps, pairing digits. */
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "mtmux",
  description:
    "Access Claude Code from any browser — remote terminal with tmux session management",
  manifest: "/manifest.json",
  /*
   * The app itself is never a search result — every route is either behind a
   * pairing credential or a thin auth form, and the ones that render at all
   * would compete with mtmux.com on the brand term. `robots.ts` states the
   * same thing for crawlers that read it; this covers the ones that don't.
   */
  robots: { index: false, follow: false },
  icons: {
    // iOS composites home-screen icon transparency against black, so the
    // rounded-corner PNGs in `icons` would pick up black corners and then be
    // masked again. `apple-icon.png` is the same mark on an opaque tile.
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    // `black-translucent` forces white status-bar glyphs unconditionally,
    // which in standalone + light theme is a white clock on `#fcfdfb`. Left
    // to `default`, iOS picks the legible pair for the scheme in use.
    statusBarStyle: "default",
    title: "mtmux",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  // Without this Chrome/Android only shrinks the *visual* viewport when the soft
  // keyboard opens, so `h-[100dvh]` keeps its full height and the whole footer
  // stack — command bar included — slides underneath the keyboard.
  interactiveWidget: "resizes-content",
  // Matches --surface-base in each scheme, so the iOS status bar and the
  // Android chrome do not sit against a colour the app never uses.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfdfb" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0b0a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  /*
   * The font variables go on <html>, not <body>.
   *
   * `--font-sans` is defined at `:root` and expands to
   * `var(--font-plex-sans), ui-sans-serif, …`. A custom property is substituted
   * using the value it has on the element that *declares* it — so with
   * `--font-plex-sans` set on <body>, the substitution inside `--font-sans`
   * happens at `:root`, finds nothing, and falls through to the system stack.
   * The page renders, in the wrong typeface, with no error anywhere. Declaring
   * them on <html> puts both in the same scope.
   */
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${plexSans.variable} ${plexMono.variable} ${martianMono.variable}`}
    >
      <body className="bg-background text-foreground overscroll-none">
        {/*
          Dark by default rather than following the OS.

          This is a terminal. The canonical mtmux look is the dark one — it is
          what the site shows, what the screenshots show, and what a shell looks
          like. Light mode is fully supported and one tap away; it is just not
          the thing to show someone who has expressed no preference.
        */}
        <ThemeProvider defaultTheme="dark">
          <PwaProvider />
          {children}
          <ToastProvider />
        </ThemeProvider>
      </body>
    </html>
  );
}
