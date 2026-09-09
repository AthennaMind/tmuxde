import { expect, test, type Page } from "@playwright/test";

/**
 * A signed-in user on a device that has never paired with anything.
 *
 * This is the single most common state for a new phone, and it rendered as
 * "you have nothing": `collectTargets()` returned `[]` the moment the browser
 * held no pairings, so someone with ten registered machines opened the
 * dashboard to an empty list with nothing on it to act on.
 *
 * The dashboard needs both a signed-in session and a broker, neither of which
 * `pnpm dev` has, so everything the page reads is stubbed at the network edge.
 * That is the point: what is under test is what the browser does with two
 * machines and no keys, not whether the broker returns them.
 */

const SERVERS = [
  {
    id: "srv-1",
    name: "gagan@thinkpad",
    slug: "thinkpad",
    publicKey: "11".repeat(32),
    online: true,
    lastSeenAt: Date.now(),
    platform: "linux",
    cliVersion: "0.4.0",
  },
  {
    id: "srv-2",
    name: "build-box",
    slug: "build-box",
    publicKey: "22".repeat(32),
    online: false,
    lastSeenAt: Date.now() - 3_600_000,
    platform: "darwin",
    cliVersion: "0.5.0",
  },
];

async function stubAccount(page: Page) {
  // better-auth's session endpoint, so `RequireSession` lets the page render.
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: { id: "sess-1", userId: "user-1" },
        user: { id: "user-1", email: "dp@example.com", name: "DP" },
      }),
    }),
  );

  await page.route("**/v1/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ servers: SERVERS }),
    }),
  );
}

test.describe("a dashboard with no pairings", { tag: "@phone" }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAccount(page);
    await page.goto("/start");
    await page.evaluate(() => {
      indexedDB.deleteDatabase("mtmux");
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test("lists every machine on the account rather than nothing", async ({
    page,
  }) => {
    await page.goto("/dashboard");

    // Both machines, by name. Before this they were filtered out entirely,
    // because they have no sessions to show — which was true, and the wrong
    // conclusion.
    await expect(page.getByText("gagan@thinkpad").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("build-box").first()).toBeVisible();

    // And the empty state is *not* what is shown.
    await expect(page.getByText("No machines yet")).toBeHidden();
  });

  test("offers an action on each unpaired machine", async ({ page }) => {
    await page.goto("/dashboard");

    // The row is an invitation to pair, not a session list. A row you cannot
    // act on is the same dead end as no row at all.
    // One per machine, not two. The page used to render every machine twice —
    // once as a session group and once under "Your machines" — so this count
    // was written against the duplicated layout.
    const pairButtons = page.getByRole("button", { name: "Pair this device" });
    await expect(pairButtons.first()).toBeVisible({ timeout: 15_000 });
    await expect(pairButtons).toHaveCount(SERVERS.length);

    // "Open" would be a promise this browser cannot keep — it holds no keys.
    await expect(page.getByRole("button", { name: "Open" })).toHaveCount(0);
  });

  test("never probes a machine it holds no keys for", async ({ page }) => {
    // A probe would open a socket authenticated with a key that does not
    // exist. `runCensus` skips unpaired targets before any of that.
    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(ws.url()));

    await page.goto("/dashboard");
    await expect(page.getByText("gagan@thinkpad").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(2_000);

    const probes = sockets.filter(
      (url) => url.includes("/_relay") || url.includes("/v1/tunnel/"),
    );
    expect(probes, `unexpected probe sockets: ${probes.join(", ")}`).toEqual(
      [],
    );
  });

  test("the unpaired row says why it has nothing to show", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText(/no keys for/).first()).toBeVisible({
      timeout: 15_000,
    });
    // Not "last seen never, press Retry", which is what an unprobed row looked
    // like before it got its own branch — a lie about a machine that is online.
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });
});
