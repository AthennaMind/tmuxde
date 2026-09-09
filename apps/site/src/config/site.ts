/**
 * Single source of truth for site-wide constants.
 *
 * Anything that appears in more than one place — the domain, the install
 * command, the version badge, nav structure — lives here so it is changed once.
 */

/**
 * The published CLI version, inlined at build time from `apps/cli/package.json`
 * by `next.config.ts`. Never edit it here — bump `apps/cli/package.json` and the
 * badge follows. The literal fallback only exists so a stray `tsc`/editor run
 * outside a Next build still typechecks.
 */
const version = process.env.NEXT_PUBLIC_MTMUX_VERSION ?? "0.0.0";

/** The one place the repository lives. Every GitHub URL below is derived from it. */
const repo = "https://github.com/mtmux/mtmux";

/** The hosted web client and dashboard, hoisted so the four links below derive from it. */
const appHost = "app.mtmux.com";

export const siteConfig = {
  name: "mtmux",
  /** Used in JSON-LD and OG tags. Not appended to page titles: titles are keyword-first. */
  legalName: "mtmux",
  domain: "mtmux.com",
  url: "https://mtmux.com",
  version,
  install: "npm i -g mtmux",
  repo,
  email: "hey@mtmux.com",
  securityEmail: "security@mtmux.com",
  privacyEmail: "privacy@mtmux.com",
  requirements: "Node 22+ · tmux · macOS · Linux · WSL",
  /** The hosted web client and dashboard. */
  appHost,
  /**
   * The four real destinations on the app origin.
   *
   * Named constants rather than an `appLink(path)` helper: there are exactly
   * four routes the app serves from here, and a helper is an invitation to
   * invent a fifth that 404s. `?next=` is honoured — `safeNext()` accepts a
   * single-slash path and the auth form replays it after sign-in.
   *
   * None of these belong in `staticRoutes` or the sitemap: the app origin
   * disallows crawling in its own robots.txt, so these are human links only.
   */
  appUrl: `https://${appHost}`,
  appSignIn: `https://${appHost}/signin`,
  appSignUp: `https://${appHost}/signup`,
  appBilling: `https://${appHost}/signin?next=/settings/billing`,
  /** The pairing broker. Self-hostable — see MTMUX_API_URL. */
  apiHost: "api.mtmux.com",
  /** The full documentation site (`apps/docs`). A separate origin, so links to it are absolute. */
  docsUrl: "https://docs.mtmux.com",
  /** The published package. The install command above is the shorthand for it. */
  npmUrl: "https://www.npmjs.com/package/mtmux",
  /**
   * The deep links the open-source section hands a reader who wants to run
   * this themselves. Named here rather than typed into the component so the
   * repo move that broke every one of these last time can only break one file.
   */
  docsSelfHosting: "https://docs.mtmux.com/docs/self-hosting",
  docsSecurity: "https://docs.mtmux.com/docs/security",
  social: {
    github: repo,
    discussions: `${repo}/discussions`,
    releases: `${repo}/releases`,
    issues: `${repo}/issues`,
    license: `${repo}/blob/main/LICENSE`,
    contributing: `${repo}/blob/main/CONTRIBUTING.md`,
    /** Container images. `mtmux-api` is the broker — the one a self-hoster needs. */
    packages: `${repo}/pkgs/container/mtmux-api`,
  },
} as const;

/** Route keys are locale-independent; hrefs are resolved through next-intl navigation. */
export const navigation = [
  { key: "features", href: "/features" },
  { key: "agents", href: "/agents" },
  { key: "docs", href: "/docs" },
  { key: "blog", href: "/blog" },
  { key: "compare", href: "/compare" },
  { key: "pricing", href: "/pricing" },
] as const;

export const footerNavigation = {
  product: [
    // The two app links live in `product` rather than `resources`: the app is
    // the product, and the footer was the only site-wide surface that could
    // carry both without competing with CopyInstall in the header.
    { key: "openApp", href: siteConfig.appUrl, external: true },
    { key: "signIn", href: siteConfig.appSignIn, external: true },
    { key: "features", href: "/features" },
    { key: "agents", href: "/agents" },
    { key: "useCases", href: "/use-cases" },
    { key: "pricing", href: "/pricing" },
    { key: "changelog", href: "/changelog" },
  ],
  resources: [
    { key: "docs", href: "/docs" },
    // docs.mtmux.com is a separate origin and had no inbound link from here at
    // all, which left 22 pages orphaned from the site that ranks for them.
    { key: "docsSite", href: siteConfig.docsUrl, external: true },
    // The page that answers "can I run this without you", which until now was
    // reachable from the home page and nowhere else on the site.
    { key: "selfHosting", href: siteConfig.docsSelfHosting, external: true },
    { key: "blog", href: "/blog" },
    { key: "faq", href: "/faq" },
    { key: "security", href: "/security" },
  ],
  compare: [
    { key: "compareAll", href: "/compare" },
    { key: "vsTmate", href: "/compare#tmate" },
    { key: "vsTtyd", href: "/compare#ttyd" },
    { key: "vsSsh", href: "/compare#ssh-apps" },
    { key: "vsVscode", href: "/compare#vscode" },
  ],
  company: [
    { key: "privacy", href: "/privacy" },
    { key: "terms", href: "/terms" },
    { key: "github", href: siteConfig.social.github, external: true },
    { key: "discussions", href: siteConfig.social.discussions, external: true },
    { key: "contact", href: `mailto:${siteConfig.email}`, external: true },
  ],
} as const;

/** Every route that should appear in the sitemap, with its crawl hints. */
export const staticRoutes = [
  { href: "/", changeFrequency: "weekly", priority: 1 },
  { href: "/features", changeFrequency: "monthly", priority: 0.9 },
  { href: "/agents", changeFrequency: "monthly", priority: 0.9 },
  { href: "/docs", changeFrequency: "weekly", priority: 0.9 },
  { href: "/blog", changeFrequency: "daily", priority: 0.9 },
  { href: "/compare", changeFrequency: "monthly", priority: 0.8 },
  { href: "/pricing", changeFrequency: "monthly", priority: 0.8 },
  { href: "/use-cases", changeFrequency: "monthly", priority: 0.7 },
  { href: "/security", changeFrequency: "monthly", priority: 0.7 },
  { href: "/faq", changeFrequency: "monthly", priority: 0.7 },
  { href: "/changelog", changeFrequency: "weekly", priority: 0.6 },
  { href: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { href: "/terms", changeFrequency: "yearly", priority: 0.3 },
] as const satisfies ReadonlyArray<{
  href: string;
  changeFrequency:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority: number;
}>;
