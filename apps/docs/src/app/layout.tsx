import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.mtmux.com"),
  title: {
    default: "mtmux docs — tmux in your browser",
    template: "%s · mtmux docs",
  },
  description:
    "Documentation for mtmux, the npm CLI that serves your tmux sessions to any browser. Install, pair a phone, understand the sealed tunnel, and self-host the whole thing.",
  applicationName: "mtmux",
  keywords: [
    "mtmux",
    "tmux web client",
    "browser terminal",
    "self-hosted terminal",
    "remote terminal mobile",
    "tmux from phone",
    "WebSocket tmux",
    "xterm.js",
    "Claude Code remote",
    "developer tools",
  ],
  // Deliberately no `url` here and no `alternates` at all. Metadata set on the
  // root layout is inherited by every page below it, so a canonical (or an
  // `og:url`) pinned to the docs homepage made all 22 pages declare themselves
  // duplicates of `/docs`. Each page sets its own self-referencing pair in
  // `docs/[[...slug]]/page.tsx`; `metadataBase` above turns the relative paths
  // it returns into absolute URLs.
  openGraph: {
    type: "website",
    siteName: "mtmux docs",
    title: "mtmux docs — tmux in your browser",
    description:
      "Install the mtmux CLI, pair a device, and understand the sealed tunnel.",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "mtmux docs",
    description: "tmux in your browser. One command, any device.",
  },
  robots: { index: true, follow: true },
};

/**
 * A *reference* to the product entity, not a second description of it.
 *
 * mtmux.com owns `#software` (see `apps/site/src/lib/structured-data.ts`),
 * where the supported systems and the price table are generated from
 * `packages/config`. The node that used to live here restated both by hand and
 * had already drifted — it claimed "Linux, macOS" against the site's
 * "macOS, Linux, WSL", and a single free Offer against the site's Free and Pro.
 * Two machine-readable descriptions of one product that disagree are worse
 * than one, so this keeps the `@id` (which is what joins the docs to the
 * entity) and drops every fact the site already states.
 */
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "@id": "https://mtmux.com/#software",
  name: "mtmux",
  url: "https://mtmux.com",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} flex min-h-screen flex-col`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
