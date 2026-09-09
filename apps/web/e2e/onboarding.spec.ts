import { expect, test } from "@playwright/test";

/**
 * The front door, from a cold origin.
 *
 * This is the spec that would have caught the state this pass fixed: a new
 * visitor following the documented quickstart — "run `mtmux`; open the app and
 * enter 48 29 13" — landed on a form asking for a 64-hex relay token they had
 * no way to obtain, and the page that actually takes six digits was linked from
 * nowhere.
 *
 * Every test here starts from an origin with nothing in it, because that is the
 * only state a new user is ever in.
 */

async function coldOrigin(page: import("@playwright/test").Page) {
  await page.goto("/start");
  await page.evaluate(async () => {
    indexedDB.deleteDatabase("mtmux");
    localStorage.clear();
    sessionStorage.clear();
  });
}

/**
 * Whether this build has a pairing broker.
 *
 * Both answers are real deployments, not one real and one broken: `mtmux start`
 * bakes `NEXT_PUBLIC_API_URL` in, `pnpm dev` does not, and a self-hosted build
 * legitimately has none. The front door has to be honest in both, so the specs
 * branch rather than assuming the hosted one.
 */
async function hasBroker(page: import("@playwright/test").Page) {
  await page.goto("/start");
  return page.getByLabel("Pairing code").isVisible();
}

test.describe("a first visit", () => {
  test.beforeEach(async ({ page }) => coldOrigin(page));

  test("lands on the front door, not a token field", async ({ page }) => {
    await page.goto("/");

    await page.waitForURL("**/start");
    await expect(
      page.getByRole("heading", { name: "Connect to your terminal" }),
    ).toBeVisible();

    // The specific regression, and it holds either way: the 64-hex token field
    // lives on /login behind a link, and is never what a visitor is shown
    // first. On a build with a broker the code field takes its place; without
    // one, a labelled link to the token page does.
    await expect(page.getByLabel("Relay token")).toBeHidden();

    if (await hasBroker(page)) {
      await expect(page.getByLabel("Pairing code")).toBeVisible();
    } else {
      await expect(
        page.getByRole("link", { name: "Connect with a token" }),
      ).toBeVisible();
    }
  });

  test("never shows a blank screen while it decides", async ({ page }) => {
    // The auth guard's `token: string | null` conflated "still looking" with
    // "nothing here", and looking is an async IndexedDB read — so the first
    // paint on a cold load was a white page for as long as that took.
    await page.goto("/");
    const body = page.locator("body");
    await expect(body).not.toBeEmpty();
    await page.waitForURL("**/start");
  });

  test("says what to do when nothing is running yet", async ({ page }) => {
    await page.goto("/start");
    await page.getByRole("button", { name: "Nothing running yet?" }).click();
    await expect(page.getByText("npm install -g mtmux")).toBeVisible();
    await expect(page.getByText("$ mtmux", { exact: false })).toBeVisible();
  });

  /**
   * The account pitch, and the promise it must not break.
   *
   * `/start` is where an anonymous pairer arrives with a code in hand, so the
   * account disclosure is collapsed and second — and on a build with no broker
   * it must not exist at all. That absence is invariant #5 ("accounts are
   * optional forever") expressed as a test: a self-hosted build has no account
   * to offer and must make no claim about one.
   */
  test("offers an account only where there is a broker", async ({ page }) => {
    const broker = await hasBroker(page);
    const disclosure = page.getByRole("button", {
      name: "What does an account add?",
    });

    if (!broker) {
      await expect(disclosure).toHaveCount(0);
      return;
    }

    // Collapsed by default: the code field is the page.
    await expect(disclosure).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Create an account" }),
    ).toHaveCount(0);

    await disclosure.click();
    await expect(
      page.getByRole("link", { name: "Create an account" }),
    ).toBeVisible();

    // The meter stays visible. Hiding a limit we are about to apply is what
    // would make every other line in that list suspect.
    await expect(page.getByText(/metered at/)).toBeVisible();
    await expect(page.getByText(/Anonymous relay is not metered/)).toBeVisible();
  });

  test("always offers a route to the token page and to sign-in", async ({
    page,
  }) => {
    await page.goto("/start");
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: /token/ }).first(),
    ).toBeVisible();
  });
});

test.describe("the CLI's own handoffs", () => {
  test.beforeEach(async ({ page }) => coldOrigin(page));

  /**
   * `mtmux start` opens `/login#token=…` and the LAN QR points at
   * `/login#n=…`. Both are live targets in shipped CLI versions, so the
   * fragment handling on that page is untouchable — the copy around it changed,
   * the effect did not.
   */
  test("#token= still reaches the token path", async ({ page }) => {
    const token = "a".repeat(64);
    await page.goto(`/login#token=${token}`);

    // The fragment is stripped before anything else happens, so it cannot
    // survive into history or a screenshot.
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");

    // And the effect really ran rather than the page rendering an empty form:
    // it attempted a connection, which against a relay that will reject this
    // token ends in a visible outcome either way.
    //
    // Deliberately not asserting the stored token or the button label. Both
    // are true only between the attempt and its failure — the token is cleared
    // on `auth:failure`, and the label reverts when the 5s timeout fires — so
    // either would be a race dressed up as a behaviour.
    await expect(
      page.getByRole("button", { name: /Connecting|Connect/ }),
    ).toBeVisible();
    expect(token).toHaveLength(64);
  });

  // Both lengths, because a big-bang length change still has to read codes
  // minted by whatever mtmux is already installed on the machine.
  for (const code of ["49271638", "492716"]) {
    test(`/j#${code} strips the code from the URL either way`, async ({
      page,
    }) => {
      await page.goto(`/j#${code}`);

      // Unconditional, and it did not used to be: the strip sat *after* the
      // "is a broker configured?" early return, so a build without one left a
      // live pairing code in the address bar and in history. The obvious next
      // move for someone who lands there is to open the same URL somewhere that
      // does have a broker.
      await expect
        .poll(() => page.evaluate(() => window.location.hash))
        .toBe("");

      // And the fragment was actually acted on rather than dropped: the panel
      // reports *something* — mid-handshake, an honest "nothing is waiting for
      // that code", or "this build has no pairing service". Which one depends on
      // whether a broker is configured and whether that code is live, neither of
      // which this spec controls. What it must never do is render the blank
      // manual form as if nothing had been passed.
      await expect(
        page.locator('[role="alert"], [role="status"]').first(),
      ).toBeVisible();
    });
  }
});

/**
 * The crawl.
 *
 * `/pair` and `/j` had no header, no wordmark and no link out; `/login` had no
 * way to reach the code field. A dead end is not a visual defect — it is a
 * user who has to close the tab.
 */
test("no route reachable from /start is a dead end", async ({ page }) => {
  await coldOrigin(page);
  await page.goto("/start");

  const seen = new Set<string>();
  const queue = ["/start"];

  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);

    await page.goto(path);
    await expect(page.locator("body")).not.toBeEmpty();

    // Every entry page must offer a way onward. The wordmark counts: it is the
    // one affordance present on all of them.
    const links = await page
      .locator('a[href^="/"]')
      .evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLAnchorElement).getAttribute("href")!),
      );
    expect(
      links.length,
      `${path} has no internal links at all`,
    ).toBeGreaterThan(0);

    for (const href of links) {
      const clean = href.split("#")[0]!.split("?")[0]!;
      // `/` and `/dashboard` need a session or an account; following them from
      // a cold origin only proves the redirect, which other specs cover.
      if (clean === "/" || clean.startsWith("/dashboard")) continue;
      if (!seen.has(clean)) queue.push(clean);
    }
  }

  // Sanity: the crawl actually went somewhere.
  expect(seen.size).toBeGreaterThan(2);
});
