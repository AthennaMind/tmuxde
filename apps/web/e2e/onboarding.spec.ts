import { expect, test } from "@playwright/test";

test("local entry offers pairing and relay token without account links", async ({
  page,
  baseURL,
}) => {
  const external: string[] = [];
  const origin = new URL(baseURL!).origin;
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) external.push(request.url());
  });
  await page.goto("/start");
  await expect(page.getByLabel("Pairing code")).toBeVisible();
  await expect(page.getByRole("link", { name: "Use a token" })).toBeVisible();
  await expect(
    page.locator('a[href="/signin"], a[href="/signup"]'),
  ).toHaveCount(0);
  expect(external).toEqual([]);
});

test("pairing rejects hosted code shapes without contacting any broker", async ({
  page,
}) => {
  await page.goto("/start");
  await page.getByLabel("Pairing code").fill("123456789");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("six-digit code");
});

test("local code fragment is stripped before user submits once", async ({
  page,
}) => {
  let claims = 0;
  await page.route("**/_pair/local", async (route) => {
    claims += 1;
    expect(route.request().postDataJSON().code).toBe("492716");
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.goto("/j#492716");
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await expect(page.getByLabel("Pairing code")).toHaveValue("492716");
  expect(claims).toBe(0);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "expired or was already used",
  );
  expect(claims).toBe(1);
});

test("malformed fragments are stripped and explained", async ({ page }) => {
  await page.goto("/j#%ZZ");
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("six-digit code");
});

test("token login stays reachable from local entry", async ({ page }) => {
  await page.goto("/start");
  await page.getByRole("link", { name: "Use a token" }).click();
  await expect(page.getByLabel("Relay token")).toBeVisible();
  await expect(
    page.getByText("docker/local/.env.token", { exact: true }),
  ).toBeVisible();
});
