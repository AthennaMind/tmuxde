import { test, expect, type Page } from "@playwright/test";

import { MIN_TAP_PX } from "./tap-target";

/**
 * The pinned ends of the keyboard toolbar.
 *
 * Everything between them lives in a horizontally scrolling strip, and the
 * strip's own source comments record what that costs: keys "past eleven icon
 * buttons — reachable only by scrolling a strip most people never realise
 * scrolls". So what is asserted here is the part that must never scroll — the
 * composer at one end, the `?` that explains the gestures at the other, and
 * copy mode in the first slot of the strip, which is still on screen without
 * scrolling.
 *
 * Same seeding as `mobile-command-bar.spec.ts`: a token gets the terminal shell
 * on screen. The socket then fails against a relay that is not running, which
 * is deliberate: it is how the difference between the buttons that need it and
 * the ones that do not gets tested at all.
 */

const TOKEN = process.env.E2E_RELAY_TOKEN ?? "dev-token";

async function openTerminal(page: Page) {
  await page.addInitScript((token: string) => {
    localStorage.setItem("mtmux-token", token);
    localStorage.setItem("mtmux-last-session", "work");
  }, TOKEN);
  await page.goto("/");
}

async function pinnedAtLeftEdge(page: Page, name: string) {
  const button = page.getByRole("button", { name });
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_PX);
  expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_PX);
  // Pinned means on screen at the edge, not merely present in a strip that
  // happens to start scrolled to the top.
  expect(box.x).toBeLessThan(MIN_TAP_PX * 2);
  return box;
}

test.describe("the toolbar's pinned ends", { tag: "@phone-only" }, () => {
  /*
   * The composer has the pinned slot: writing a command is the most common
   * thing anyone does down here, and it is the one action that stays live
   * while the socket is down.
   */
  test("pins the composer at the left edge, big enough to hit", async ({
    page,
  }) => {
    await openTerminal(page);
    await pinnedAtLeftEdge(page, "Write a command");
  });

  /*
   * Copy mode is the only way to get text out of a phone terminal — the pane
   * is a WebGL canvas, so there is nothing to press and hold over, and the
   * long press there means "this pane's options". It leads the strip, which
   * puts it on screen without scrolling, and it wears a clipboard: the scroll
   * icon was accurate about what the view is and told nobody what it is for.
   */
  test("puts copy mode in reach without scrolling", async ({ page }) => {
    await openTerminal(page);
    const copy = page.getByRole("button", { name: "Open copy mode" });
    await expect(copy).toBeVisible();
    const box = (await copy.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_PX);
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_PX);
    expect(box.x).toBeLessThan(MIN_TAP_PX * 3);
  });

  test("pins the gesture cheat sheet at the right edge", async ({ page }) => {
    await openTerminal(page);
    const help = page.getByRole("button", { name: "Gestures and shortcuts" });
    await expect(help).toBeVisible();

    const box = (await help.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_PX);
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_PX);
    expect(box.x + box.width).toBeGreaterThan(
      page.viewportSize()!.width - MIN_TAP_PX * 2,
    );
  });

  test("explains the long press, which nothing else on screen does", async ({
    page,
  }) => {
    await openTerminal(page);
    await page.getByRole("button", { name: "Gestures and shortcuts" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Press and hold");
    await expect(sheet).toContainText("Pinch");
  });

  /*
   * The composer is independent of the socket: writing a command while the
   * connection is down is how you have one ready when it comes back.
   */
  test("keeps the composer live with the socket down", async ({ page }) => {
    await openTerminal(page);
    const write = page.getByRole("button", { name: "Write a command" });
    await expect(write).toBeVisible();
    await expect(write).toBeEnabled();

    await write.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
