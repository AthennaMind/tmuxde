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

const PORT = Number(process.env.E2E_PORT ?? 14100);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // One worker: every spec drives the same IndexedDB origin, and a device lock
  // is per-origin state. Parallel workers would fight over it.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
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
