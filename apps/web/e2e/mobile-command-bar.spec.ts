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
 * The command bar on a phone.
 *
 * The reported problem was that it grew to four rows and ate the screen: with a
 * soft keyboard up, a terminal had a couple of hundred pixels left and its own
 * input was taking a third of what remained. The assertion that matters is the
 * anti-regression one — the field is one line, and *stays* one line after 300
 * characters go into it.
 *
 * Reached by seeding a token so the app renders the terminal shell. The socket
 * will fail to authenticate against a broker that is not there, which is fine
 * and is precisely why §4.2 says the field must not disable when disconnected.
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

test.describe("the one-line bar", { tag: "@phone-only" }, () => {
  test("is one line, and stays one line", async ({ page }) => {
    await openTerminal(page);
    const field = bar(page);
    await expect(field).toBeVisible();

    const before = (await field.boundingBox())!.height;
    expect(before).toBeGreaterThanOrEqual(40);
    expect(before).toBeLessThanOrEqual(48);

    // The regression: an auto-grow effect measured scrollHeight and pushed the
    // field to four rows. There is no measuring effect any more, and this is
    // what proves it did not come back.
    await field.fill("x".repeat(300));
    const after = (await field.boundingBox())!.height;
    expect(after).toBe(before);
  });

  test("uses a font iOS will not zoom into", async ({ page }) => {
    await openTerminal(page);
    // 16px exactly, not `text-base` — `text-base` is 1rem and tracks the user's
    // browser default, so a 14px default still triggers zoom-on-focus. Fixing
    // that with `maximum-scale=1` instead would be a WCAG 1.4.4 violation.
    const size = await bar(page).evaluate((el) =>
      parseFloat(getComputedStyle(el).fontSize),
    );
    expect(size).toBeGreaterThanOrEqual(16);
  });

  test("stays inside the viewport at 412px and 320px", async ({ page }) => {
    await openTerminal(page);
    for (const width of [412, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBe(false);
    }
  });

  test("no longer duplicates the keyboard toolbar's keys", async ({ page }) => {
    await openTerminal(page);
    // Ctrl+C, Tab and ↑ all exist in KeyboardToolbar 46px below. ↑ especially
    // had to go: it sent \x1b[A to the *pty*, so it recalled shell history
    // while the field it sat inside stayed empty.
    const barRow = page
      .locator("form, div")
      .filter({ has: bar(page) })
      .last();
    await expect(barRow.getByRole("button", { name: /Ctrl\+C/i })).toHaveCount(
      0,
    );
    await expect(
      barRow.getByRole("button", { name: /Previous command/i }),
    ).toHaveCount(0);
  });

  test("keeps typing during a reconnect", async ({ page }) => {
    await openTerminal(page);
    // Disabling the field on disconnect throws away what someone is typing
    // while the socket comes back. Only Send is disabled.
    await expect(bar(page)).toBeEnabled();
    await bar(page).fill("echo still here");
    await expect(bar(page)).toHaveValue("echo still here");
  });
});

test.describe("the microphone", { tag: "@phone-only" }, () => {
  test("is absent when the browser has no Web Speech", async ({ page }) => {
    await page.addInitScript((token: string) => {
      localStorage.setItem("mtmux-token", token);
      localStorage.setItem("mtmux-last-session", "work");
      // Firefox's situation. There is no action a user can take, so the right
      // answer is to render nothing rather than a permanently dead button.
      delete (window as unknown as Record<string, unknown>).SpeechRecognition;
      delete (window as unknown as Record<string, unknown>)
        .webkitSpeechRecognition;
    }, TOKEN);
    await page.goto("/");
    await expect(bar(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Dictate a command/i }),
    ).toHaveCount(0);
  });

  test("appears purely from feature detection", async ({ page }) => {
    await page.addInitScript((token: string) => {
      localStorage.setItem("mtmux-token", token);
      localStorage.setItem("mtmux-last-session", "work");
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition =
        function StubRecognition() {
          return {
            lang: "",
            continuous: false,
            interimResults: false,
            start() {},
            stop() {},
            abort() {},
          };
        };
    }, TOKEN);
    await page.goto("/");
    await expect(bar(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Dictate a command/i }),
    ).toBeVisible();
  });
});
