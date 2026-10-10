import { test, expect, type Page } from "@playwright/test";
import { openMobileTerminal } from "./mobile-input-fixture.js";

async function swipe(page: Page, direction: "left" | "right", y: number) {
  const cdp = await page.context().newCDPSession(page);
  const from = direction === "right" ? 80 : 300;
  const to = direction === "right" ? 300 : 80;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from, y }],
  });
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from + ((to - from) * step) / 8, y }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

test.describe("file viewer navigation", { tag: "@phone-only" }, () => {
  test.skip(
    !process.env.E2E_FILE_NAV_PATH,
    "Requires isolated file navigation fixture",
  );
  test.beforeEach(async ({ page }) => {
    await openMobileTerminal(page);
    await page.getByRole("button", { name: "Sessions", exact: true }).tap();
    await page.getByRole("button", { name: "Files", exact: true }).tap();
    const browser = page.getByRole("region", { name: "Repository browser" });
    await expect(
      browser.locator('nav [aria-current="location"]'),
    ).toHaveAttribute("title", process.env.E2E_FILE_NAV_PATH!);
    await browser.getByRole("button", { name: /nav-folder/ }).tap();
    await browser.getByRole("button", { name: /example.ts/ }).tap();
    await expect(browser).toContainText("export const example = 1;");
  });

  test("browser back and forward restore file views instead of Sessions", async ({
    page,
  }) => {
    const browser = page.getByRole("region", { name: "Repository browser" });
    await page.goBack();
    await expect(
      browser.getByRole("button", { name: /example.ts/ }),
    ).toBeVisible();
    await expect(
      browser.locator('nav [aria-current="location"]'),
    ).toHaveAttribute("title", `${process.env.E2E_FILE_NAV_PATH}/nav-folder`);
    await page.goForward();
    await expect(browser).toContainText("export const example = 1;");
  });

  test("swipes navigate back and forward without leaving Files", async ({
    page,
  }) => {
    const browser = page.getByRole("region", { name: "Repository browser" });
    const box = (await browser.boundingBox())!;
    await swipe(page, "right", box.y + 25);
    await expect(
      browser.getByRole("button", { name: /example.ts/ }),
    ).toBeVisible();
    await swipe(page, "left", box.y + 25);
    await expect(browser).toContainText("export const example = 1;");
    await browser.getByRole("button", { name: "Go back", exact: true }).tap();
    await expect(
      browser.getByRole("button", { name: /example.ts/ }),
    ).toBeVisible();
    await browser.getByRole("button", { name: "Go back", exact: true }).tap();
    await expect(
      browser.getByRole("button", { name: "Go back", exact: true }),
    ).toBeDisabled();
    await swipe(page, "right", box.y + 25);
    await expect(browser).toBeVisible();
    await expect(
      browser.getByRole("button", { name: /nav-folder/ }),
    ).toBeVisible();
  });

  test("wide code keeps horizontal scrolling instead of navigating", async ({
    page,
  }) => {
    const browser = page.getByRole("region", { name: "Repository browser" });
    await browser.getByRole("button", { name: "Back", exact: true }).tap();
    await browser.getByRole("button", { name: /wide.txt/ }).tap();
    const content = browser.getByRole("region", { name: "File contents" });
    const box = (await content.boundingBox())!;
    await swipe(page, "left", box.y + 35);
    await expect
      .poll(() => content.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
    await expect(browser).toContainText("wide.txt");
  });

  test("native return to Files restores preview while explicit reopening starts fresh", async ({
    page,
  }) => {
    const browser = page.getByRole("region", { name: "Repository browser" });
    await page.getByRole("button", { name: "Sessions", exact: true }).tap();
    await page.goBack();
    await expect(browser).toContainText("export const example = 1;");
    await page.goBack();
    await expect(
      browser.getByRole("button", { name: /example.ts/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Terminal", exact: true }).tap();
    await page.getByRole("button", { name: "Files", exact: true }).tap();
    await expect(
      browser.locator('nav [aria-current="location"]'),
    ).toHaveAttribute("title", process.env.E2E_FILE_NAV_PATH!);
    await expect(
      browser.getByRole("button", { name: "Go back", exact: true }),
    ).toBeDisabled();
  });

  test("desktop arrows use viewer history", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Open files", exact: true }).click();
    const browser = page.getByRole("region", { name: "Repository browser" });
    await browser.getByRole("button", { name: /nav-folder/ }).click();
    await browser.getByRole("button", { name: /example.ts/ }).click();
    await expect(browser).toContainText("export const example = 1;");
    await browser.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(
      browser.getByRole("button", { name: /example.ts/ }),
    ).toBeVisible();
    await browser
      .getByRole("button", { name: "Go forward", exact: true })
      .click();
    await expect(browser).toContainText("export const example = 1;");
  });
});
