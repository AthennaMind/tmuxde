import { test, expect } from "@playwright/test";
import { openMobileTerminal } from "./mobile-input-fixture.js";

test.describe("mobile terminal controls", { tag: "@phone-only" }, () => {
  test.beforeEach(async ({ page }) => openMobileTerminal(page));

  test("essential keys fit without scrolling at narrow phone widths", async ({
    page,
  }) => {
    await expect(page.locator("header")).toHaveCount(0);
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 800 });
      const keys = page
        .getByRole("group", { name: "Terminal keyboard" })
        .getByRole("button");
      await expect(keys).toHaveCount(12);
      for (const key of await keys.all()) {
        const box = (await key.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    }
  });

  test("extra keys, copy, and help stay reachable through More", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "More terminal controls" }).tap();
    await expect(
      page.getByRole("button", { name: "Open copy mode" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send Ctrl+C" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "More keys" })).toBeVisible();
    await page.getByRole("button", { name: "Gestures and shortcuts" }).tap();
    await expect(page.getByRole("dialog")).toContainText("Press and hold");
  });

  test("keyboard-open controls use one row and More restores hidden keys", async ({
    page,
  }) => {
    const group = page.getByRole("group", { name: "Terminal keyboard" });
    await page.evaluate(() => {
      document.documentElement.dataset.keyboard = "open";
    });
    await expect(group.locator("button:visible")).toHaveCount(6);
    expect((await group.boundingBox())!.height).toBe(52);
    for (const name of [
      "Show keyboard",
      "Esc",
      "Tab",
      "Upload photo",
      "Enter",
      "More terminal controls",
    ]) {
      await expect(
        group.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    await group.getByRole("button", { name: "More terminal controls" }).tap();
    await expect(
      page.getByRole("button", { name: "Ctrl", exact: true }),
    ).toBeVisible();
    await expect(group.getByRole("button", { name: "Arrow up" })).toBeVisible();
    await expect(
      group.getByRole("button", { name: "Alt", exact: true }),
    ).toBeVisible();
    await expect(
      group.getByRole("button", { name: "Write a command" }),
    ).toBeVisible();
    await group.getByRole("button", { name: "More terminal controls" }).tap();
    expect((await group.boundingBox())!.height).toBe(52);
  });

  test("Draft opens optional editor", async ({ page }) => {
    await page.getByRole("button", { name: "Write a command" }).tap();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("textbox", { name: "Command", exact: true }),
    ).toBeFocused();
  });
});
