import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests, which this repo has never had.
 *
 * The unit suite covers the parts that can be reasoned about in isolation —
 * the attach state machine, the fan-out, the envelope. What it cannot reach is
 * the half of this product that only exists in a browser: a passkey ceremony, a
 * PIN survived across a reload, an OAuth redirect landing back on the right
 * page. Those are what live here.
 *
 * Deliberately **not** covered, because it cannot be: conditional-UI autofill.
 * The browser's own autofill dropdown is not scriptable — not by Playwright and
 * not by CDP — so `signIn.passkey({ autoFill: true })` goes on the manual
 * checklist in `e2e/MANUAL.md` alongside iOS Safari as a PWA, Android Chrome,
 * and macOS Safari.
 *
 * Run with `pnpm --filter @app/web e2e`. Browsers are not installed by
 * `pnpm install` — run `pnpm --filter @app/web exec playwright install chromium`
 * once.
 */

/**
 * Lab mode, and why it is a branch rather than a second config file.
 *
 * `node scripts/lab.mjs test` sets `E2E_LAB` along with the port, the token and
 * the relay URL, and that script is the single source of truth for all three —
 * duplicating the numbers here is how they drift. Everything the two modes
 * share (the timeouts, the trace policy, the one-worker rule) genuinely is
 * shared, and a second file would fork it.
 *
 * What the branch changes: a different web port, a different Next dist
 * directory, `reuseExistingServer: false`, and a different set of projects
 * pointed at `e2e/lab`.
 */
const LAB = process.env.E2E_LAB === "1";

/*
 * A dedicated port, not the dev port.
 *
 * This used to default to 14100, and the note on `reuseExistingServer` below
 * explains what that cost once. It cost it again: on a machine with a `pnpm
 * dev` left running on 14100, twelve mobile specs failed against a months-old
 * bundle, and moving to a free port made every one of them pass unchanged.
 *
 * Documenting a trap is not the same as removing it. 14180 is free, is clear
 * of every load-bearing port in CLAUDE.md invariant 8, and — being nobody's
 * dev port — cannot be occupied by something the suite would then adopt.
 */
const PORT = Number(process.env.E2E_PORT ?? (LAB ? 14190 : 14180));
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * The lab's projects.
 *
 * Five, and none of them is padding.
 *
 * `lab-webkit` exists because the config's stated reason for being
 * Chromium-only — the CDP virtual authenticator — is an authentication
 * concern, and no terminal spec touches an authenticator. WebKit is installed.
 * Excluding the only engine that resembles the platform whose keyboard
 * behaviour this app works hardest around would be leaving the most valuable
 * coverage on the floor for a reason that does not apply.
 *
 * `lab-landscape` and `lab-tablet` are not optional extras either.
 * `MOBILE_MEDIA_QUERY` in `src/lib/mobile-query.ts` deliberately classifies
 * iPhone-landscape and tablets as mobile through its `pointer: coarse`
 * clauses, and that logic has never been exercised by a test — so the two
 * viewports where the app has to decide "is this a phone?" and could get it
 * wrong are the two nobody has ever run. Rotation is also where the terminal
 * subtree used to be torn down and rebuilt.
 */
const labProjects = [
  {
    name: "lab-desktop",
    use: { ...devices["Desktop Chrome"] },
    grep: /@terminal/,
  },
  {
    name: "lab-phone",
    use: { ...devices["Pixel 7"] },
    grep: /@terminal/,
  },
  {
    name: "lab-webkit",
    use: { ...devices["iPhone 14"] },
    grep: /@terminal/,
  },
  {
    // `devices["iPhone 14 landscape"]` rather than a hand-rolled viewport, so
    // the DPR, the user agent and `isMobile` stay consistent with the portrait
    // project and the only difference is the one under test.
    name: "lab-landscape",
    use: { ...devices["iPhone 14 landscape"] },
    grep: /@terminal/,
  },
  {
    name: "lab-tablet",
    use: { ...devices["iPad Mini"] },
    grep: /@terminal/,
  },
];

export default defineConfig({
  testDir: "./e2e",
  /*
   * The lab specs and everything else never run together, in either direction.
   *
   * In lab mode only the lab specs run: they need a container the other specs
   * neither have nor want, and `grep: /@terminal/` alone would still load and
   * evaluate every other spec file.
   *
   * Out of lab mode the exclusion has to be stated too, and it was not. The
   * `chromium` project only excludes `@phone-only`, so it was collecting all
   * nineteen lab specs and running them against a lab that is not there —
   * `pnpm --filter @app/web e2e` exited non-zero on a clean tree with
   * nineteen failures that could not have passed. A test that cannot pass in
   * the mode it is being run in is not a failure, it is a mis-scoped run.
   */
  ...(LAB
    ? { testMatch: /e2e\/lab\/.*\.spec\.ts/ }
    : { testIgnore: /e2e\/lab\// }),
  // One worker: every spec drives the same IndexedDB origin, and a device lock
  // is per-origin state. Parallel workers would fight over it.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  /*
   * Lab specs get three times the budget, and it is not slack.
   *
   * A lab test is browser → relay → tmux → pty and back, on a cold `next dev`
   * compile of the terminal route, against a session that may be replaying
   * 50k lines of scrollback. The attach alone can outlast the default.
   */
  timeout: LAB ? 90_000 : 30_000,
  expect: { timeout: LAB ? 15_000 : 7_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "off",
  },
  projects: LAB
    ? labProjects
    : [
        {
          // Chromium only. The virtual authenticator these specs need is a CDP
          // feature, and CDP is Chromium's.
          name: "chromium",
          use: { ...devices["Desktop Chrome"] },
          // Only the specs that are *meaningless* off a phone are excluded. See
          // the note below for why this is a tag and not a filename pattern.
          grepInvert: /@phone-only/,
        },
        {
          /*
           * The phone project.
           *
           * ## Why tags and not filenames
           *
           * This used to be `testMatch: /mobile-.*\.spec\.ts/`, which meant a spec
           * ran at a phone viewport only if somebody had thought to *name the file*
           * `mobile-…`. Two specs did. The dashboard's did not — so no dashboard
           * assertion had ever executed at 390px, and that is precisely why a
           * header that overflows a phone and a "Pair this device" button 8px under
           * the tap-target floor both shipped. A convention that has to be
           * remembered at file-creation time is not a test strategy.
           *
           * `@phone` means "also run this at a phone viewport"; `@phone-only` means
           * "this asserts nothing on a desktop" — the command bar and the composer,
           * which exist because of the soft keyboard. `/@phone/` matches both, so a
           * `@phone-only` spec still runs here.
           *
           * `Pixel 7` rather than any of the iPhone descriptors: those default to
           * WebKit, and this suite is Chromium-only for the reason above. What is
           * asserted at this size — a one-line field, a 16px font, a header that
           * does not overflow, a 44px button — is engine-independent enough for
           * that to be a fair trade. Real iOS behaviour stays on the manual
           * checklist.
           */
          name: "mobile-chromium",
          use: { ...devices["Pixel 7"] },
          grep: /@phone/,
        },
      ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : LAB
      ? {
          /*
           * `next dev` directly, not `pnpm dev`.
           *
           * `pnpm dev` is the CLI's single-port server: it serves the web client
           * *and* a relay on the same port, against the host's own tmux. That is
           * the right default everywhere else and precisely wrong here — the lab
           * exists to drive the relay in the container, and a same-origin relay
           * would quietly win at `resolveRelayWsUrl()` and the whole rig would
           * test the host's tmux instead.
           */
          command: `pnpm exec next dev --port ${PORT}`,
          cwd: ".",
          url: `${baseURL}/login`,
          /*
           * Never adopt a stray server, and this is the config that already
           * learned why. The note below records `reuseExistingServer: true`
           * picking up a months-old production build on 14100 and running a
           * whole suite against it. A lab run asserting terminal fidelity
           * against the wrong bundle would be worse than useless: it would be
           * confidently wrong.
           */
          reuseExistingServer: false,
          timeout: 180_000,
          env: {
            ...(process.env as Record<string, string>),
            PORT: String(PORT),
            /*
             * Its own dist directory.
             *
             * Next takes a build lock per output directory, and `.next-dev` is
             * very likely already held by a developer's `pnpm dev` on 14100.
             * Sharing it makes the lab server fail to start, or worse, makes the
             * two servers fight over the same compiled output.
             */
            NEXT_DIST_DIR: ".next-lab",
            /*
             * The whole point: the client talks to the container, not to this
             * origin. Set by `scripts/lab.mjs`; the default here only keeps a
             * hand-run `E2E_LAB=1 playwright test` honest.
             */
            NEXT_PUBLIC_RELAY_URL:
              process.env.NEXT_PUBLIC_RELAY_URL ?? "ws://127.0.0.1:24390",
            // Absent, deliberately. `isHostedBuild` is `NEXT_PUBLIC_API_URL !==
            // undefined`, and a lab run must exercise the self-hosted path —
            // which is the one the relay token and `mtmux-token` belong to.
            NEXT_PUBLIC_API_URL: "",
          },
        }
      : {
          command: `pnpm dev`,
          cwd: "../..",
          url: `${baseURL}/login`,
          reuseExistingServer: true,
          timeout: 120_000,
          env: {
            ...(process.env as Record<string, string>),
            /*
             * `pnpm dev` reads PORT, not E2E_PORT.
             *
             * Without this, `E2E_PORT=14180 playwright test` pointed the browser
             * at 14180 and started the dev server on 14100 — where, on a machine
             * that has `mtmux` installed globally, an unrelated *production*
             * build is usually already listening. `reuseExistingServer` then
             * happily adopted it and the whole suite ran against a months-old
             * bundle. Setting an E2E port has to move both halves.
             */
            PORT: String(PORT),
            /*
             * The dashboard specs need a hosted build.
             *
             * `isHostedBuild` is `NEXT_PUBLIC_API_URL !== undefined`, and the
             * repo's `.env` does not set it — correctly, since the default dev
             * loop is the self-hosted one. With it absent every account route
             * renders "Hosted accounts aren't configured" and the dashboard
             * specs fail on a missing element rather than on anything they
             * assert. Nothing has to be listening on the other end: every call
             * to it is stubbed with `page.route`.
             */
            NEXT_PUBLIC_API_URL:
              process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:14400",
          },
        },
});
