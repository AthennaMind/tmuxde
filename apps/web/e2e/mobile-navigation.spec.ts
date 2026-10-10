import { test, expect } from "@playwright/test";
import { openMobileTerminal, inputs } from "./mobile-input-fixture.js";

test.describe("mobile navigation", { tag: "@phone-only" }, () => {
  test.beforeEach(async ({ page }) => openMobileTerminal(page));

  test("tmux actions live under More and tabs hide with keyboard", async ({
    page,
  }) => {
    await expect(
      page.getByRole("button", { name: "Tmux actions", exact: true }),
    ).toBeHidden();
    const tabs = page
      .locator(".mtmux-hide-when-keyboard")
      .filter({ has: page.getByRole("button", { name: /pane list/ }) });
    await expect(tabs).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.dataset.keyboard = "open";
    });
    await expect(tabs).toBeHidden();
    await page.evaluate(() => {
      document.documentElement.dataset.keyboard = "closed";
    });
    await expect(tabs).toBeVisible();
    await page.getByRole("button", { name: "More terminal controls" }).tap();
    await page.getByRole("button", { name: "Tmux actions", exact: true }).tap();
    await expect(page.getByRole("dialog")).toContainText("Tmux Actions");
  });

  test("navigation taps and holds preserve hidden keyboard and cancel cleanly", async ({
    page,
  }) => {
    await page
      .getByRole("button", { name: "Show keyboard", exact: true })
      .tap();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await page.getByRole("button", { name: "More terminal controls" }).tap();
    await page
      .getByRole("button", { name: "Navigation mode", exact: true })
      .tap();
    const group = page.getByRole("group", { name: "Terminal navigation" });
    await expect(group).toBeVisible();
    expect((await group.boundingBox())!.height).toBe(52);
    await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();
    // Terminal capability replies can arrive during attach; count arrow bytes only.
    const arrowInputs = async () =>
      (await inputs(page)).filter((entry) => entry.data === "\x1b[B");
    const down = group.getByRole("button", { name: "Arrow down" });
    await down.tap();
    await expect.poll(async () => (await arrowInputs()).length).toBe(1);
    expect((await arrowInputs())[0]?.data).toBe("\x1b[B");
    const box = (await down.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    const after = (await arrowInputs()).length;
    expect(after).toBeGreaterThan(3);
    await page.waitForTimeout(250);
    expect((await arrowInputs()).length).toBe(after);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await down.dispatchEvent("pointercancel", { pointerId: 1 });
    await page.mouse.up();
    const cancelled = (await arrowInputs()).length;
    await page.waitForTimeout(500);
    expect((await arrowInputs()).length).toBe(cancelled);
    await group.getByRole("button", { name: "Esc", exact: true }).tap();
    await group.getByRole("button", { name: "Enter", exact: true }).tap();
    await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();
    expect((await inputs(page)).slice(-2).map((entry) => entry.data)).toEqual([
      "\x1b",
      "\r",
    ]);
    await group
      .getByRole("button", { name: "Show keyboard", exact: true })
      .tap();
    await expect(
      page.getByRole("group", { name: "Terminal keyboard" }),
    ).toBeVisible();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  });

  test("mobile renderer raises dim opacity while preserving normal colors", async ({
    page,
  }) => {
    await expect
      .poll(async () => page.locator(".xterm style").allTextContents())
      .not.toEqual([]);
    const styles = (await page.locator(".xterm style").allTextContents()).join(
      "\n",
    );
    const dimColors = [
      ...styles.matchAll(/\.xterm-dim\s*\{\s*color:\s*(#[\da-f]{8})/gi),
    ].map((m) => m[1]!);
    expect(dimColors.length).toBeGreaterThan(16);
    expect(dimColors.every((color) => color.endsWith("cc"))).toBe(true);
    expect(styles).toMatch(/\.xterm-fg-5\s*\{\s*color:\s*#[\da-f]{6};/i);
  });
  test("Safari edge sampler exceeds minimum size without painting over terminal", async ({
    page,
  }) => {
    const sampler = page.locator(".mtmux-status-bar");
    const style = await sampler.evaluate((element) => {
      const css = getComputedStyle(element);
      return {
        height: parseFloat(css.height),
        position: css.position,
        clip: css.backgroundClip,
        pointerEvents: css.pointerEvents,
        color: css.backgroundColor,
      };
    });
    expect(style.height).toBeGreaterThan(10);
    expect(style.position).toBe("fixed");
    expect(style.clip).toBe("text");
    expect(style.pointerEvents).toBe("none");
    expect(style.color).not.toBe("rgba(0, 0, 0, 0)");
    const before = await sampler.boundingBox();
    await page.evaluate(() => {
      document.documentElement.dataset.keyboard = "open";
    });
    expect(await sampler.boundingBox()).toEqual(before);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(sampler).toHaveCount(0);
  });
});
