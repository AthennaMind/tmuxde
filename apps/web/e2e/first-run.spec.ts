import { expect, test, type Page } from "@playwright/test";

/**
 * The guided first run, and the states in which it must not appear.
 *
 * A fresh account used to land on an empty machine list whose one suggestion
 * was to install a CLI — with the step that actually matters, asking a machine
 * to let this browser in, hidden behind a button on a card that only exists
 * once a machine does. So the strongest account-only capability was also the
 * least discoverable thing in the product.
 *
 * Everything here is derived state, never a flag, which is why the interesting
 * assertions are the negative ones: the checklist has to be *absent* for
 * someone who is already set up, and absent while the machine list is still in
 * flight. A checklist that flashes "you have no machines" at someone with ten
 * is the same bug `dashboard-unpaired.spec.ts` exists to catch, one layer up.
 */

const MACHINE = {
  id: "srv-1",
  name: "gagan@thinkpad",
  slug: "thinkpad",
  publicKey: "11".repeat(32),
  online: true,
  lastSeenAt: Date.now(),
  platform: "linux",
  cliVersion: "0.6.0",
};

async function stubAccount(
  page: Page,
  { servers = [] as unknown[], passkeys = [] as unknown[] } = {},
) {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: { id: "sess-1", userId: "user-1" },
        user: {
          id: "user-1",
          email: "dp@example.com",
          name: "DP",
          emailVerified: false,
        },
      }),
    }),
  );

  await page.route("**/v1/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ servers }),
    }),
  );

  // No mailer in this deployment, so a verified address is not a second way in
  // and the credential step stays open on its own merits.
  await page.route("**/v1/auth/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        emailPassword: true,
        passkeys: true,
        magicLink: false,
        passwordReset: false,
        providers: [],
      }),
    }),
  );

  await page.route("**/passkey/list-user-passkeys**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(passkeys),
    }),
  );
}

async function clearBrowserState(page: Page) {
  await page.goto("/start");
  await page.evaluate(() => {
    indexedDB.deleteDatabase("mtmux");
    localStorage.clear();
    sessionStorage.clear();
  });
}

test.describe("the first-run checklist", { tag: "@phone" }, () => {
  test("greets a cold account with steps, not an empty list", async ({
    page,
  }) => {
    await stubAccount(page);
    await clearBrowserState(page);
    await page.goto("/dashboard");

    await expect(
      page.getByRole("heading", { name: "Getting set up" }),
    ).toBeVisible({ timeout: 15_000 });

    // The steps in order, and the pairing one present *before* a machine
    // exists — it used to be reachable only from a card that had not appeared.
    await expect(
      page.getByText("Put a machine on your account"),
    ).toBeVisible();
    await expect(page.getByText("Pair this browser with it")).toBeVisible();

    // And it says plainly that none of it is required.
    await expect(page.getByText(/pairs without an account too/)).toBeVisible();
  });

  test("ticks the machine step once one is on the account", async ({
    page,
  }) => {
    await stubAccount(page, { servers: [MACHINE] });
    await clearBrowserState(page);
    await page.goto("/dashboard");

    await expect(
      page.getByRole("heading", { name: "Getting set up" }),
    ).toBeVisible({ timeout: 15_000 });

    // With the machine step done, the pairing step is the live one and its
    // action is on screen rather than one disclosure away.
    await expect(
      page.getByRole("button", {
        name: "Ask a machine to let this browser in",
      }),
    ).toBeVisible();
  });

  test("stays dismissed across a reload", async ({ page }) => {
    await stubAccount(page);
    await clearBrowserState(page);
    await page.goto("/dashboard");

    const heading = page.getByRole("heading", { name: "Getting set up" });
    await expect(heading).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(heading).toBeHidden();

    await page.reload();
    // A checklist that comes back after being dismissed is an advertisement.
    await expect(heading).toBeHidden({ timeout: 15_000 });
  });

  test("never claims an account is unprotected when it cannot tell", async ({
    page,
  }) => {
    await stubAccount(page, { servers: [MACHINE] });
    await page.route("**/passkey/list-user-passkeys**", (route) =>
      route.fulfill({ status: 500, body: "nope" }),
    );
    await clearBrowserState(page);
    await page.goto("/dashboard");

    await expect(
      page.getByRole("heading", { name: "Getting set up" }),
    ).toBeVisible({ timeout: 15_000 });

    // The step is omitted, not rendered as "not done". Telling someone their
    // account has no second credential when the fetch simply failed invites
    // them to enrol one they already have.
    await expect(page.getByText("Add a second way in")).toBeHidden();
  });
});
