import { expect, test, type Page } from "@playwright/test";

/**
 * The billing panel, driven through every state it can render.
 *
 * These are stubbed at `/v1/billing` rather than run against a real payment
 * provider, and that is the point: this is the coverage that lives permanently
 * and runs in CI. A real checkout needs a real account, a real card and a
 * webhook round trip, so it is a separate manual tier — see `e2e/MANUAL.md`.
 *
 * What the stub is worth: for months this panel could not render the machine
 * meter at all (it read `usage.servers`, which the broker never sent), showed
 * an Upgrade button on deployments where checkout answered 503, and dropped
 * anyone returning from a successful payment onto their *old* plan because the
 * webhook that grants it races the redirect. None of those are visible without
 * driving the states, and none of them throw.
 */

const GIB = 1024 ** 3;

type BillingBody = Record<string, unknown>;

function free(overrides: BillingBody = {}): BillingBody {
  return {
    plan: "free",
    planSource: "free",
    status: "none",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    trial: null,
    usage: {
      month: "2026-08",
      bytes: 1 * GIB,
      seconds: 60,
      sessions: 2,
      servers: 1,
    },
    pricing: { pro: { monthlyUsd: 10, yearlyUsd: 100 } },
    billingEnabled: true,
    ...overrides,
  };
}

function pro(overrides: BillingBody = {}): BillingBody {
  return free({
    plan: "pro",
    planSource: "paid",
    status: "active",
    currentPeriodEnd: Date.parse("2026-09-01T00:00:00Z"),
    usage: {
      month: "2026-08",
      bytes: 20 * GIB,
      seconds: 900,
      sessions: 9,
      servers: 4,
    },
    ...overrides,
  });
}

async function stubAccount(page: Page) {
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
}

/**
 * Serve `/v1/billing` from a mutable slot.
 *
 * A queue rather than a constant so the post-checkout poll can be tested: the
 * first read answers free, the next answers pro, which is exactly the sequence
 * a real webhook produces. The last entry sticks, so a single-element queue
 * behaves like a constant.
 */
async function stubBilling(page: Page, bodies: BillingBody[]) {
  let index = 0;
  await page.route("**/v1/billing", (route) => {
    const body = bodies[Math.min(index, bodies.length - 1)]!;
    index += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function open(page: Page, query = "") {
  await page.goto(`/settings/billing${query}`);
}

test.beforeEach(async ({ page }) => {
  await stubAccount(page);
  await page.goto("/start");
  await page.evaluate(() => {
    indexedDB.deleteDatabase("mtmux");
    localStorage.clear();
    sessionStorage.clear();
  });
});

test("a free account sees its plan, both meters and the upgrade card", async ({
  page,
}) => {
  await stubBilling(page, [free()]);
  await open(page);

  await expect(page.getByText("Free", { exact: true })).toBeVisible();
  await expect(page.getByText(/free plan\. No card/i)).toBeVisible();

  // The traffic meter, and — the one that was dead — the machine meter.
  await expect(
    page.getByRole("progressbar", { name: "Relayed data this month" }),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Registered machines" }),
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Upgrade to Pro" }),
  ).toBeEnabled();
});

test("the machine meter reads full at the free plan's single machine", async ({
  page,
}) => {
  // `PLANS.free.servers === 1`, so one registered machine is 100% — this is the
  // limit a single person actually collides with, and the meter has to say so
  // before they hit the 402 rather than after.
  await stubBilling(page, [free()]);
  await open(page);
  await expect(
    page.getByRole("progressbar", { name: "Registered machines" }),
  ).toHaveAttribute("aria-valuenow", "100");
});

test("a paid account sees the renewal date and a portal button, not an upgrade", async ({
  page,
}) => {
  await stubBilling(page, [pro()]);
  await open(page);

  await expect(page.getByText("Pro", { exact: true })).toBeVisible();
  await expect(page.getByText(/Renews on/i)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manage billing" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upgrade to Pro" }),
  ).toHaveCount(0);
});

test("a trial says how long is left and still offers the upgrade", async ({
  page,
}) => {
  await stubBilling(page, [
    pro({
      planSource: "trial",
      status: "none",
      trial: {
        status: "active",
        daysLeft: 4,
        endsAt: Date.parse("2026-08-14T00:00:00Z"),
      },
    }),
  ]);
  await open(page);

  await expect(page.getByText("Trial", { exact: true })).toBeVisible();
  await expect(page.getByText(/4 days left on your free trial/i)).toBeVisible();
  // A trial has no Dodo customer to manage, and every reason to be sold to.
  await expect(
    page.getByRole("button", { name: "Manage billing" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Upgrade to Pro" }),
  ).toBeVisible();
});

test("a trial is never rendered as 'Ending'", async ({ page }) => {
  // `status: "none"` is in the ENDED set, so without the trial guard a trialing
  // account is told its subscription is winding down. It has no subscription.
  await stubBilling(page, [
    pro({
      planSource: "trial",
      status: "none",
      trial: { status: "active", daysLeft: 6, endsAt: null },
    }),
  ]);
  await open(page);
  await expect(page.getByText("Ending", { exact: true })).toHaveCount(0);
});

test("a failed payment is an alert with a way out", async ({ page }) => {
  await stubBilling(page, [pro({ status: "on_hold" })]);
  await open(page);

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert.getByText(/didn't go through/i)).toBeVisible();
  await expect(
    alert.getByRole("button", { name: "Update payment method" }),
  ).toBeVisible();
  await expect(page.getByText("Payment failed")).toBeVisible();
});

test("a cancelled subscription says how long access lasts", async ({
  page,
}) => {
  await stubBilling(page, [pro({ status: "cancelled" })]);
  await open(page);

  await expect(page.getByText("Ending", { exact: true })).toBeVisible();
  await expect(page.getByText(/Pro access continues until/i)).toBeVisible();
});

test("a broker with no payment provider does not offer an upgrade it cannot sell", async ({
  page,
}) => {
  await stubBilling(page, [free({ billingEnabled: false })]);
  await open(page);

  const upgrade = page.getByRole("button", { name: "Upgrade to Pro" });
  await expect(upgrade).toBeDisabled();
  await expect(page.getByText(/no payment provider configured/i)).toBeVisible();
});

test("the checkout request carries the selected interval", async ({ page }) => {
  await stubBilling(page, [free()]);

  const bodies: unknown[] = [];
  await page.route("**/v1/billing/checkout", async (route) => {
    bodies.push(route.request().postDataJSON());
    // No URL back, so the panel stays put rather than navigating away mid-test.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });

  await open(page);
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ plan: "pro", interval: "monthly" });

  await page.getByRole("radio", { name: /Yearly/ }).click();
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual({ plan: "pro", interval: "yearly" });
});

test("a 503 from checkout is readable, not a blank failure", async ({
  page,
}) => {
  await stubBilling(page, [free()]);
  await page.route("**/v1/billing/checkout", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Billing is not configured." }),
    }),
  );

  await open(page);
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();
  await expect(page.getByText(/Billing is not configured/i)).toBeVisible();
});

test("returning from a successful checkout confirms rather than showing the old plan", async ({
  page,
}) => {
  // The sequence a real payment produces: the redirect beats the webhook, so
  // the first read is still free and a later one is pro.
  await stubBilling(page, [free(), free(), pro()]);
  await open(page, "?checkout=complete");

  await expect(page.getByText(/Confirming your payment/i)).toBeVisible();
  // …and it resolves on its own, without a reload.
  await expect(page.getByText(/Renews on/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Confirming your payment/i)).toHaveCount(0);
});

test("the checkout parameter is stripped so a reload does not re-confirm", async ({
  page,
}) => {
  await stubBilling(page, [pro()]);
  await open(page, "?checkout=complete");
  await expect(page.getByText("Pro", { exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe("");
});

test("the billing panel survives a broker that cannot answer", async ({
  page,
}) => {
  await page.route("**/v1/billing", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Something broke." }),
    }),
  );
  await open(page);

  await expect(page.getByText(/Couldn't load your plan/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});
