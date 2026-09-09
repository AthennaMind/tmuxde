import { test, expect, type Page } from "@playwright/test";

/**
 * The dev stack's own token (`apps/cli/scripts/dev.mjs`).
 *
 * A made-up token is not enough: the terminal layout's auth guard bounces to
 * `/start` when the relay refuses it, so the bar never renders. The *socket*
 * failing later is fine and is exactly why §4.2 says the field must not
 * disable when disconnected — but it has to get on screen first.
 */
const TOKEN = process.env.E2E_RELAY_TOKEN ?? "dev-token";

/**
 * The composer.
 *
 * It exists because the one-line bar sends on Enter, and a multi-line command
 * is one you want to read before it runs. What is asserted here is the part
 * that made it a Radix `Dialog` rather than the `fixed inset-0` pattern used
 * elsewhere in that directory: a real focus trap, a real Escape, focus
 * restored on close — the things a text-entry surface over a live pty cannot do
 * without.
 */

async function openTerminal(page: Page) {
  // The callback is serialised and runs in the page, so anything it needs has
  // to be passed as an argument — a module-scope constant is simply undefined
  // there, and the failure is a silent `ReferenceError` inside the page.
  await page.addInitScript((token: string) => {
    localStorage.setItem("mtmux-token", token);
    localStorage.setItem("mtmux-last-session", "work");
  }, TOKEN);
  await page.goto("/");
}

const bar = (page: Page) => page.getByRole("textbox", { name: "Command" });
const expand = (page: Page) =>
  page.getByRole("button", { name: /Open the command composer/i });
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
    await bar(page).fill("echo one");
    await expand(page).click();

    const editor = dialog(page).getByRole("textbox", { name: "Command" });
    await expect(editor).toHaveValue("echo one");

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
  "a multi-line paste in the bar opens the composer intact",
  { tag: "@phone-only" },
  async ({ page }) => {
    await openTerminal(page);
    await bar(page).focus();
    await page.evaluate(() => {
      const field = document.activeElement as HTMLTextAreaElement;
      const data = new DataTransfer();
      data.setData("text", "echo one\necho two\necho three");
      field.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Collapsing it to one line would silently change what was pasted; leaving
    // it in a one-line field would hide what is about to run.
    await expect(dialog(page)).toBeVisible();
    await expect(
      dialog(page).getByRole("textbox", { name: "Command" }),
    ).toHaveValue("echo one\necho two\necho three");
  },
);
