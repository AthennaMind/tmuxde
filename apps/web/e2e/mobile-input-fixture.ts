import { expect, type Page } from "@playwright/test";

type InputMessage = { type: string; data?: string; command?: string };
type TestWindow = Window & { terminalInputs: InputMessage[] };

export async function openMobileTerminal(page: Page) {
  await page.addInitScript(
    ({ token, session }) => {
      localStorage.setItem("mtmux-token", token);
      localStorage.setItem("mtmux-last-session", session);
      const target = window as unknown as TestWindow;
      target.terminalInputs = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          const message = JSON.parse(data);
          // Observe input without typing into the connected host session.
          if (["terminal:input", "command:send"].includes(message.type)) {
            target.terminalInputs.push(message);
            return;
          }
        }
        return send.call(this, data);
      };
    },
    {
      token: process.env.E2E_RELAY_TOKEN ?? "dev-token",
      session: process.env.E2E_SESSION ?? "work",
    },
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Show keyboard", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".xterm-screen")).toBeVisible();
}

export async function inputs(page: Page) {
  return page.evaluate(() => (window as unknown as TestWindow).terminalInputs);
}
