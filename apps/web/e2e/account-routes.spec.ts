import { expect, test, type Page } from "@playwright/test";

/**
 * The account routes render, inside one shell, with a 404 that is not Next's.
 *
 * ## What this is defending
 *
 * `/settings` was a top-level route with its own full-screen chrome, so moving
 * between it and `/settings/security` swapped the entire page shell — a bespoke
 * bar with a back arrow became the account header, and two pages under one URL
 * prefix looked like two different products. It now lives under `(account)`,
 * which is a route move, and route moves are the kind of change that typechecks
 * and then 404s.
 *
 * The 404 itself is the other half: there was no `not-found.tsx` anywhere, so a
 * mistyped path rendered Next's built-in page — unstyled, in the wrong theme,
 * with no route back into the app. On a PWA with no address bar that is a dead
 * end you close the app to escape.
 */

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
  await page.route("**/v1/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ servers: [] }),
    }),
  );
}

test("device settings live under the account shell now", async ({ page }) => {
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });
  // The shared chrome, rather than a second bespoke header.
  await expect(
    page.getByRole("banner").getByRole("link", { name: "mtmux" }),
  ).toBeVisible();
  // And still reachable without an account: this is the enrolment entry point
  // for a self-hosted device that has never signed in.
  await expect(page.getByRole("button", { name: /Disconnect/ })).toBeVisible();
});

test("security links to device settings rather than a fourth nav item", async ({
  page,
}) => {
  await stubAccount(page);
  await page.goto("/settings/security");
  await expect(
    page.getByRole("heading", { name: "Security", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });

  // Three links, not four — the header has to fit a phone.
  await expect(
    page.getByRole("navigation", { name: "Account" }).getByRole("link"),
  ).toHaveCount(3);

  const link = page.getByRole("link", { name: "Device settings" });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/settings$/);
});

test(
  "an unknown path gets the app's own 404",
  { tag: "@phone" },
  async ({ page }) => {
    const response = await page.goto("/this-route-does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "There is no page here" }),
    ).toBeVisible();
    // The part that makes it not a dead end.
    await expect(page.getByRole("link", { name: /Go to mtmux/ })).toBeVisible();
  },
);
