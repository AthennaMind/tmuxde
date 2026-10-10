import { test, expect } from "@playwright/test";
import { openMobileTerminal, inputs } from "./mobile-input-fixture.js";

test.describe("live mobile typing", { tag: "@phone-only" }, () => {
  test.beforeEach(async ({ page }) => openMobileTerminal(page));

  test("opens native input and sends real Enter from keyboard and toolbar", async ({
    page,
  }) => {
    await expect(
      page.getByRole("textbox", { name: "Command", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Show keyboard", exact: true })
      .tap();
    const input = page.getByRole("textbox", {
      name: "Terminal input",
      exact: true,
    });
    await expect(input).toBeFocused();
    expect(await input.getAttribute("enterkeyhint")).toBe("enter");
    expect(
      await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Enter", exact: true }).tap();
    await expect(input).toBeFocused();
    const sent = await inputs(page);
    expect(sent.filter((m) => m.type === "command:send")).toHaveLength(0);
    expect(sent.filter((m) => m.data === "\r")).toHaveLength(2);
    expect(sent).toContainEqual({ type: "terminal:input", data: "x" });
  });

  test("Ctrl and Alt affect next native key without dropping focus", async ({
    page,
  }) => {
    await page
      .getByRole("button", { name: "Show keyboard", exact: true })
      .tap();
    const input = page.getByRole("textbox", {
      name: "Terminal input",
      exact: true,
    });
    await page.getByRole("button", { name: "More terminal controls" }).tap();
    const ctrl = page.getByRole("button", { name: "Ctrl", exact: true });
    await ctrl.tap();
    await expect(input).toBeFocused();
    await expect(ctrl).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.type("c");
    await expect(ctrl).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.type("c");
    await page.getByRole("button", { name: "Alt", exact: true }).tap();
    await page.keyboard.type("b");
    expect(await inputs(page)).toEqual(
      expect.arrayContaining([
        { type: "terminal:input", data: "\x03" },
        { type: "terminal:input", data: "c" },
        { type: "terminal:input", data: "\x1bb" },
      ]),
    );
  });

  test("arrow and Tab preserve typing focus, keyboard can be dismissed", async ({
    page,
  }) => {
    await page
      .getByRole("button", { name: "Show keyboard", exact: true })
      .tap();
    await page.getByRole("button", { name: "Arrow up", exact: true }).tap();
    await page.getByRole("button", { name: "Tab", exact: true }).tap();
    await expect(
      page.getByRole("textbox", { name: "Terminal input", exact: true }),
    ).toBeFocused();
    expect(await inputs(page)).toEqual(
      expect.arrayContaining([
        { type: "terminal:input", data: "\x1b[A" },
        { type: "terminal:input", data: "\t" },
      ]),
    );
    await page
      .getByRole("button", { name: "Hide keyboard", exact: true })
      .tap();
    await expect(
      page.getByRole("textbox", { name: "Terminal input", exact: true }),
    ).not.toBeFocused();
  });

  test("arrows send navigation without opening dismissed keyboard", async ({
    page,
  }) => {
    const input = page.getByRole("textbox", {
      name: "Terminal input",
      exact: true,
    });
    await page
      .getByRole("button", { name: "Show keyboard", exact: true })
      .tap();
    await page
      .getByRole("button", { name: "Hide keyboard", exact: true })
      .tap();
    await expect(input).not.toBeFocused();

    for (const [direction, data] of [
      ["up", "\x1b[A"],
      ["down", "\x1b[B"],
      ["right", "\x1b[C"],
      ["left", "\x1b[D"],
    ]) {
      await page
        .getByRole("button", { name: `Arrow ${direction}`, exact: true })
        .tap();
      await expect(input).not.toBeFocused();
      expect(await inputs(page)).toContainEqual({
        type: "terminal:input",
        data,
      });
    }
    await expect(
      page.getByRole("button", { name: "Show keyboard", exact: true }),
    ).toBeVisible();
  });
});
