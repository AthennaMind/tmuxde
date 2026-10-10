import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { openMobileTerminal } from "./mobile-input-fixture.js";

// Run against isolated repository fixture, never mutate user's repository.
const fixture = process.env.E2E_REPO_PATH;
test.describe("repository browser", { tag: "@phone-only" }, () => {
  test.skip(
    !fixture,
    "Requires E2E_REPO_PATH and matching tmux session fixture",
  );
  test.beforeEach(async ({ page }) => openMobileTerminal(page));

  test("Files inherits pane directory and previews source on mobile", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Files", exact: true }).tap();
    const browser = page.getByRole("region", { name: "Repository browser" });
    await expect(
      browser.locator('nav [aria-current="location"]'),
    ).toHaveAttribute("title", fixture!);
    await browser.getByRole("button", { name: /src files/ }).tap();
    await browser.getByRole("button", { name: /widget.ts/ }).tap();
    await expect(browser).toContainText("export const value = 1;");
    await expect(browser.locator("[data-syntax-token]").first()).toBeVisible();
    expect(await browser.locator("code").allTextContents()).toContain(
      "export const value = 1;",
    );
    await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();
    await browser.getByRole("button", { name: "Wrap lines" }).tap();
    await expect(
      browser.getByRole("button", { name: "Wrap lines" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Terminal", exact: true }).tap();
    await page.getByRole("button", { name: "Files", exact: true }).tap();
    await expect(
      browser.locator('nav [aria-current="location"]'),
    ).toHaveAttribute("title", fixture!);
  });

  test("current changes separate index, working tree, new files and binary previews", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Files", exact: true }).tap();
    const browser = page.getByRole("region", { name: "Repository browser" });
    await browser.getByRole("tab", { name: /^Changes/ }).tap();
    await browser
      .getByRole("region", { name: "Unstaged files" })
      .getByRole("button", { name: /staged.ts/ })
      .tap();
    await expect(browser).toContainText("-const staged = 1;");
    await expect(browser).toContainText("+const staged = 2;");
    await expect(browser.locator("[data-syntax-token]").first()).toBeVisible();
    expect(await browser.locator("code").allTextContents()).toContain(
      "+const staged = 2;",
    );
    await browser.getByRole("button", { name: "Back", exact: true }).tap();
    await browser
      .getByRole("region", { name: "Staged files", exact: true })
      .getByRole("button", { name: /staged.ts/ })
      .tap();
    await expect(browser).toContainText("-const staged = 0;");
    await expect(browser).toContainText("+const staged = 1;");
    await browser.getByRole("button", { name: "Back", exact: true }).tap();
    await browser
      .getByRole("region", { name: "Untracked files" })
      .getByRole("button", { name: "Untracked new.ts", exact: true })
      .tap();
    await expect(browser).toContainText("+export const fresh = true;");
    await browser.getByRole("button", { name: "Back", exact: true }).tap();
    await browser
      .getByRole("region", { name: "Untracked files" })
      .getByRole("button", { name: /binary.bin/ })
      .tap();
    await expect(browser).toContainText(/Binary/i);
  });

  test("change tree groups folders, opens diffs and remembers layout", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Files", exact: true }).tap();
    const browser = page.getByRole("region", { name: "Repository browser" });
    await browser.getByRole("tab", { name: /^Changes/ }).tap();
    await browser.getByRole("button", { name: "Tree", exact: true }).tap();
    const group = browser.getByRole("region", {
      name: "Untracked files",
      exact: true,
    });
    const folder = group
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "src files" }) });
    const file = folder.getByRole("button", { name: /new.ts/ });
    await expect(file).toBeVisible();
    await folder.locator("summary").click();
    await expect(file).toBeHidden();
    await folder.locator("summary").click();
    await file.click();
    await expect(browser).toContainText("+export const nested = true;");
    await browser.getByRole("button", { name: "Back", exact: true }).tap();
    await expect(
      browser.getByRole("button", { name: "Tree", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Terminal", exact: true }).tap();
    await page.getByRole("button", { name: "Files", exact: true }).tap();
    await browser.getByRole("tab", { name: /^Changes/ }).tap();
    await expect(
      browser.getByRole("button", { name: "Tree", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await browser.getByRole("button", { name: "List", exact: true }).tap();
    await expect(
      group.getByRole("button", { name: /src files\/new.ts/ }),
    ).toBeVisible();
  });

  test("desktop Files opens and closes repository panel", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Open files", exact: true }).click();
    const browser = page.getByRole("region", { name: "Repository browser" });
    await expect(
      browser.locator('nav [aria-current="location"]'),
    ).toHaveAttribute("title", fixture!);
    await browser.getByRole("tab", { name: /^Changes/ }).click();
    await browser.getByRole("button", { name: "Tree", exact: true }).click();
    await expect(
      browser.getByRole("button", { name: "Tree", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await browser
      .getByRole("region", { name: "Unstaged files" })
      .getByRole("button", { name: /README.md/ })
      .click();
    await expect(browser).toContainText("+Updated description.");
    await browser.getByRole("button", { name: "Close files" }).click();
    await expect(browser).toHaveCount(0);
    await expect(page.locator(".xterm-screen")).toBeVisible();
  });
  test("reopening Files reads current pane directory after shell cd", async ({
    page,
  }) => {
    const pane = process.env.E2E_REPO_PANE;
    test.skip(
      !pane || !process.env.E2E_SESSION?.startsWith("mtmux-repo-e2e-"),
      "Requires isolated tmux fixture",
    );
    await page.getByRole("button", { name: "Files", exact: true }).tap();
    const browser = page.getByRole("region", { name: "Repository browser" });
    await expect(
      browser.locator('nav [aria-current="location"]'),
    ).toHaveAttribute("title", fixture!);
    const changeDirectory = (directory: string) => {
      const quoted = "'" + directory.replaceAll("'", "'\\''") + "'";
      execFileSync("tmux", ["send-keys", "-t", pane!, "-l", `cd ${quoted}`]);
      execFileSync("tmux", ["send-keys", "-t", pane!, "Enter"]);
    };
    try {
      changeDirectory(`${fixture}/src files`);
      await expect
        .poll(() =>
          execFileSync(
            "tmux",
            ["display-message", "-p", "-t", pane!, "#{pane_current_path}"],
            { encoding: "utf8" },
          ).trim(),
        )
        .toBe(`${fixture}/src files`);
      await page.getByRole("button", { name: "Terminal", exact: true }).tap();
      await page.getByRole("button", { name: "Files", exact: true }).tap();
      await expect(
        browser.locator('nav [aria-current="location"]'),
      ).toHaveAttribute("title", `${fixture}/src files`);
      await expect(
        browser.getByRole("button", { name: /widget.ts/ }),
      ).toBeVisible();
    } finally {
      changeDirectory(fixture!);
    }
  });
});
