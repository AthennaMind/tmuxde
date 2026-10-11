import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@repo/ui/providers/theme-provider";
import { ToastProvider } from "@repo/ui/providers/toast-provider";
import { PwaProvider } from "@/components/pwa/pwa-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "tmuxde",
  description: "An IDE with tmux as its backend. Nothing leaves your network.",
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
    title: "tmuxde",
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
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-background text-foreground overscroll-none">
        {/*
          Dark by default rather than following the OS.

          This is a terminal. The canonical tmuxde look is the dark one — it is
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
