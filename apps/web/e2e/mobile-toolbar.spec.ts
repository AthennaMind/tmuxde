import { test, expect, type Page } from "@playwright/test";

import { MIN_TAP_PX } from "./tap-target";

/**
 * The pinned start of the keyboard toolbar.
 *
 * Everything else in that row lives in a horizontally scrolling strip, and the
 * strip's own source comments record what that costs: keys "past eleven icon
 * buttons — reachable only by scrolling a strip most people never realise
 * scrolls". So what is asserted here is the part that must never scroll.
 *
 * Same seeding as `mobile-command-bar.spec.ts`: a token gets the terminal shell
 * on screen. The socket then fails against a broker that is not running, which
 * is deliberate — this button has to work anyway.
 */

const TOKEN = process.env.E2E_RELAY_TOKEN ?? "dev-token";

async function openTerminal(page: Page) {
  await page.addInitScript((token: string) => {
    localStorage.setItem("mtmux-token", token);
    localStorage.setItem("mtmux-last-session", "work");
  }, TOKEN);
  await page.goto("/");
}

test.describe("the toolbar's pinned start", { tag: "@phone-only" }, () => {
  test("offers text mode without scrolling, and big enough to hit", async ({
    page,
  }) => {
    await openTerminal(page);
    const write = page.getByRole("button", { name: "Write a command" });
    await expect(write).toBeVisible();

    const box = (await write.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_PX);
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_PX);
    // Pinned means on screen at the left edge, not merely present in a strip
    // that happens to start scrolled to the top.
    expect(box.x).toBeLessThan(MIN_TAP_PX * 2);
  });

  test("opens the composer, where a line can be read before it runs", async ({
    page,
  }) => {
    await openTerminal(page);
    await page.getByRole("button", { name: "Write a command" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("still works with the socket down", async ({ page }) => {
    // The relay is not there in this environment, which is the point: a
    // command can be written while disconnected and sent when it comes back.
    await openTerminal(page);
    await expect(
      page.getByRole("button", { name: "Write a command" }),
    ).toBeEnabled();
  });
});
