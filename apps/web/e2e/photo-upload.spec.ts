import { test, expect } from "@playwright/test";
import { openMobileTerminal, inputs } from "./mobile-input-fixture.js";

// Valid PNG with padding exercises multiple chunks without uploading user data.
const png = Buffer.concat([
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
  Buffer.alloc(300000, 42),
]);

for (const desktop of [false, true]) {
  test(`photo picker uploads original bytes and inserts path on ${desktop ? "desktop" : "mobile"}`, async ({
    page,
  }) => {
    await openMobileTerminal(page);
    if (desktop) await page.setViewportSize({ width: 1440, height: 900 });
    const chooserPromise = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Upload photo", exact: true })
      .click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: "screenshot.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect
      .poll(async () =>
        (await inputs(page)).some((m) => m.data?.includes("/photo-")),
      )
      .toBe(true);
    const message = (await inputs(page)).find((m) =>
      m.data?.includes("/photo-"),
    )!;
    expect(message.type).toBe("terminal:input");
    expect(message.data).not.toMatch(/[\r\n]/);
    // Exclude terminal escape sequences from bracketed paste payloads.
    // eslint-disable-next-line no-control-regex
    const path = message.data!.match(/\/[^\s'\x1b]*photo-[a-f0-9-]+\.png/)![0];
    const response = await page.request.get(
      `/file?path=${encodeURIComponent(path)}`,
      {
        headers: { Authorization: `Bearer ${process.env.E2E_RELAY_TOKEN}` },
      },
    );
    expect(response.ok()).toBe(true);
    expect(await response.body()).toEqual(png);
    if (!desktop)
      await expect(
        page.getByRole("textbox", { name: "Terminal input", exact: true }),
      ).not.toBeFocused();
    await expect(
      page.getByRole("button", { name: "Upload photo", exact: true }),
    ).toBeEnabled();
    await expect(
      page
        .getByRole("button", { name: "Upload photo", exact: true })
        .getByRole("img", { name: "Uploaded photo" }),
    ).toBeVisible();
    if (!desktop) {
      await page.setViewportSize({ width: 320, height: 800 });
      const photo = page.getByRole("button", {
        name: "Upload photo",
        exact: true,
      });
      const sizes = await photo.evaluate((button) => ({
        width: button.clientWidth,
        contents: button.scrollWidth,
      }));
      expect(sizes.contents).toBeLessThanOrEqual(sizes.width);
      await page.getByRole("button", { name: "More terminal controls" }).tap();
    }
    await page
      .getByRole("button", { name: "Recent photos (1)", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByRole("img", { name: "Uploaded photo" }),
    ).toBeVisible();
    const beforeReuse = (await inputs(page)).length;
    await page.getByRole("button", { name: /^Reuse photo/ }).click();
    await expect
      .poll(async () => (await inputs(page)).length)
      .toBe(beforeReuse + 1);
    expect((await inputs(page)).at(-1)?.data).toBe(message.data);
    await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();
    await page
      .getByRole("button", { name: "Recent photos (1)", exact: true })
      .click();
    await page.route("**/file?*", (route) =>
      route.fulfill({ status: 404, body: "File missing" }),
    );
    await page.getByRole("button", { name: /^Reuse photo/ }).click();
    await expect(page.getByRole("alert")).toContainText("Photo unavailable");
    expect((await inputs(page)).length).toBe(beforeReuse + 1);
  });
}

test("closing More during upload keeps transfer and path insertion working", async ({
  page,
}) => {
  await openMobileTerminal(page);
  await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string" && JSON.parse(data).type === "file:upload") {
        setTimeout(() => send.call(this, data), 200);
        return;
      }
      send.call(this, data);
    };
  });
  await page.getByRole("button", { name: "More terminal controls" }).tap();
  await page
    .getByLabel("Choose photo")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
  await expect(
    page.getByRole("button", { name: "Upload photo", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "More terminal controls" }).tap();
  await expect
    .poll(async () =>
      (await inputs(page)).some((m) => m.data?.includes("/photo-")),
    )
    .toBe(true);
  await expect(
    page.getByRole("textbox", { name: "Terminal input", exact: true }),
  ).not.toBeFocused();
});
