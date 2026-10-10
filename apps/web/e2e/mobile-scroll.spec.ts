import { test, expect } from "@playwright/test";
import { openMobileTerminal } from "./mobile-input-fixture.js";

test.describe("mobile scrolling during redraw", { tag: "@phone-only" }, () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const target = window as unknown as { scrollMessages: unknown[] };
      target.scrollMessages = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (
          typeof data === "string" &&
          JSON.parse(data).type === "tmux:scroll"
        ) {
          target.scrollMessages.push(JSON.parse(data));
          return;
        }
        return send.call(this, data);
      };
    });
    await openMobileTerminal(page);
  });

  for (const delivery of ["surface", "document", "detached"] as const) {
    test(`scroll survives replaced text node with ${delivery} events`, async ({
      page,
    }) => {
      await page.evaluate(async (delivery) => {
        const surface = document.querySelector(
          ".touch-none.touch-callout-none",
        )!;
        const row = document.createElement("span");
        surface.appendChild(row);
        const touch = (y: number) =>
          new Touch({ identifier: 71, target: row, clientX: 150, clientY: y });
        const emit = (
          target: EventTarget,
          type: string,
          y: number,
          ended = false,
        ) => {
          const contact = touch(y);
          target.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: ended ? [] : [contact],
              changedTouches: [contact],
            }),
          );
        };
        emit(row, "touchstart", 200);
        row.remove();
        const target =
          delivery === "document"
            ? document
            : delivery === "detached"
              ? row
              : surface;
        emit(target, "touchmove", 230);
        emit(target, "touchmove", 310);
        // Cross hold deadline while moving so lost movement opens pane menu.
        await new Promise((resolve) => setTimeout(resolve, 650));
        emit(target, "touchend", 310, true);
      }, delivery);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { scrollMessages: unknown[] })
                .scrollMessages.length,
          ),
        )
        .toBeGreaterThan(0);
      await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();
    });
  }

  test("lifting from replaced row cancels pending pane menu", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const surface = document.querySelector(".touch-none.touch-callout-none")!;
      const row = document.createElement("span");
      surface.appendChild(row);
      const contact = new Touch({
        identifier: 72,
        target: row,
        clientX: 150,
        clientY: 200,
      });
      row.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          cancelable: true,
          touches: [contact],
          changedTouches: [contact],
        }),
      );
      row.remove();
      document.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          cancelable: true,
          touches: [],
          changedTouches: [contact],
        }),
      );
    });
    await page.waitForTimeout(650);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("native drag survives touched node removal", async ({ page }) => {
    const point = await page.evaluate(() => {
      const surface = document.querySelector(".touch-none.touch-callout-none")!;
      const box = surface.getBoundingClientRect();
      const row = document.createElement("span");
      row.id = "scroll-redraw-target";
      Object.assign(row.style, {
        position: "absolute",
        inset: "0",
        zIndex: "10",
      });
      surface.appendChild(row);
      return { x: box.x + box.width / 2, y: box.y + 100 };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await page.evaluate(() =>
      document.getElementById("scroll-redraw-target")!.remove(),
    );
    for (const distance of [30, 60, 100]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: point.x, y: point.y + distance }],
      });
    }
    await page.waitForTimeout(650);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { scrollMessages: unknown[] }).scrollMessages
              .length,
        ),
      )
      .toBeGreaterThan(0);
    await cdp.detach();
  });

  test("deliberate still hold keeps pane menu available", async ({ page }) => {
    await page.evaluate(() => {
      const surface = document.querySelector(".touch-none.touch-callout-none")!;
      const contact = new Touch({
        identifier: 73,
        target: surface,
        clientX: 150,
        clientY: 200,
      });
      surface.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          cancelable: true,
          touches: [contact],
          changedTouches: [contact],
        }),
      );
    });
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("Zoom this pane");
  });
});
