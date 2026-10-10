import { test, expect, type Page } from "@playwright/test";

import { openMobileTerminal as openTerminal } from "./mobile-input-fixture.js";

const expand = (page: Page) =>
  page.getByRole("button", { name: "Write a command" });
const dialog = (page: Page) => page.getByRole("dialog");

test(
  "expand opens a dialog with focus in the editor",
  { tag: "@phone-only" },
  async ({ page }) => {
    await openTerminal(page);
    await expand(page).click();

    await expect(dialog(page)).toBeVisible();
    // Focus goes to the editor rather than the close button — which is what
    // someone who just tapped "expand" was reaching for.
    await expect(
      dialog(page).getByRole("textbox", { name: "Command" }),
    ).toBeFocused();
  },
);

test(
  "Escape closes it and restores focus",
  { tag: "@phone-only" },
  async ({ page }) => {
    await openTerminal(page);
    await expand(page).click();
    await expect(dialog(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);

    // Focus must come back to the page, not fall to <body> — the whole reason
    // this is a Radix Dialog is that the surface behind it is a live pty, and a
    // dropped focus there means the next keystroke goes to the shell.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName))
      .not.toBe("BODY");
  },
);

test(
  "Android Back closes it without leaving the route",
  { tag: "@phone-only" },
  async ({ page }) => {
    await openTerminal(page);
    const before = page.url();
    await expand(page).click();
    await expect(dialog(page)).toBeVisible();

    await page.goBack();
    await expect(dialog(page)).toHaveCount(0);
    // The history entry carries `mobileTab`, or `use-mobile-history` reads a
    // popstate with no tab and flips the tab as a side effect of the dialog
    // closing — dismissing a dialog would land the user on another screen.
    expect(page.url()).toBe(before);
  },
);

test(
  "fits inside the visual viewport",
  { tag: "@phone-only" },
  async ({ page }) => {
    await openTerminal(page);
    await expand(page).click();

    // `position: fixed` sizes to the *layout* viewport, and
    // `interactiveWidget: "resizes-content"` is Chromium-only — `inset-0` puts
    // the Send button under the keyboard on iOS Safari.
    const height = (await dialog(page).boundingBox())!.height;
    const visual = await page.evaluate(
      () => window.visualViewport?.height ?? window.innerHeight,
    );
    expect(height).toBeLessThanOrEqual(visual + 1);
  },
);

test(
  "carries the draft in and back out again",
  { tag: "@phone-only" },
  async ({ page }) => {
    await openTerminal(page);
    await expand(page).click();

    const editor = dialog(page).getByRole("textbox", { name: "Command" });
    await editor.fill("echo one");

    // Enter adds a line here rather than sending — the asymmetry with the bar is
    // the reason the composer exists.
    await editor.press("End");
    await editor.press("Enter");
    await editor.type("echo two");
    await expect(editor).toHaveValue("echo one\necho two");

    // The label is the review affordance: "Send 2 lines" is the last chance to
    // notice that a paste brought more than expected.
    await expect(
      dialog(page).getByRole("button", { name: /Send 2 lines/i }),
    ).toBeVisible();
  },
);

test(
  "draft preserves pasted lines without submitting",
  { tag: "@phone-only" },
  async ({ page }) => {
    await openTerminal(page);
    await expand(page).click();
    const editor = dialog(page).getByRole("textbox", {
      name: "Command",
      exact: true,
    });
    await editor.fill("echo one\necho two\necho three");
    await expect(editor).toHaveValue("echo one\necho two\necho three");
    await expect(
      dialog(page).getByRole("button", { name: /Send 3 lines/i }),
    ).toBeVisible();
  },
);
