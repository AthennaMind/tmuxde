import { test, expect } from "./fixtures";
import { overflow, tapTargets, a11y } from "./detectors";

/**
 * "Let this device in?" — the one dialog that must never be got wrong.
 *
 * ## Why it is tested here and not in the unit suite
 *
 * Everything that decides is already unit-tested on both sides:
 * `device-approval.test.ts` proves the relay abstains rather than denying and
 * refuses to show the question to a share, and `access-prompt.test.ts` proves
 * the race cannot let "I could not ask" beat a human. Neither of them can see
 * the thing that actually admits a stranger to a shell, which is a button on a
 * phone.
 *
 * The failure modes worth catching are all layout and interaction:
 *
 *  - a dialog that overflows a 390px viewport, so "Deny" is off-screen;
 *  - a tap target under the floor on the one screen where a mis-tap grants
 *    access rather than costing a scroll;
 *  - a dismissal — backdrop, Escape, an X in the corner — that the user reads
 *    as a refusal but which refuses nothing, leaving the request to expire
 *    while they believe they answered it;
 *  - six digits that wrap, or are announced as a number rather than as digits,
 *    on a dialog whose entire security value is comparing them to another
 *    screen.
 *
 * ## The seam
 *
 * A request cannot be manufactured: it comes out of a real CPace exchange with
 * the broker, and the lab has neither a broker nor a second browser. The store
 * is exposed on `window` under `NODE_ENV !== "production"` — the same seam, and
 * the same reasoning, as `__mtmuxTerminalHandle`. What is being tested is the
 * dialog, so injecting the question and reading back the answer is the right
 * boundary; who is allowed to ask and what an unanswered question means are
 * both proven server-side, where they are enforced.
 */

const REQUEST = {
  type: "device:approval-request" as const,
  id: "lab-approval-1",
  deviceLabel: "Chrome on iOS",
  accountEmail: "someone@example.com",
  sas: "408315",
  expiresAt: 0,
};

/** Raise the question, and start capturing what the client sends back. */
async function raise(
  page: import("@playwright/test").Page,
  overrides: Partial<typeof REQUEST> = {},
) {
  await page.evaluate(
    ([request]) => {
      const w = window as unknown as {
        __mtmuxDeviceApproval?: {
          getState(): { open(r: unknown): void };
        };
        __labSent?: string[];
      };
      // Tap the socket once, so the answer can be read as what actually left
      // the browser rather than as a store transition.
      if (!w.__labSent) {
        w.__labSent = [];
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (this: WebSocket, data) {
          if (typeof data === "string") w.__labSent!.push(data);
          return send.call(this, data);
        };
      }
      w.__mtmuxDeviceApproval!.getState().open({
        ...request,
        expiresAt: Date.now() + 100_000,
      });
    },
    [{ ...REQUEST, ...overrides }] as const,
  );
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function answers(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    ((window as unknown as { __labSent?: string[] }).__labSent ?? [])
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((m) => m.type === "device:approve"),
  );
}

test.describe("device approval", { tag: "@terminal" }, () => {
  test("shows who is asking, and the digits to compare", async ({
    page,
    lab,
  }) => {
    await lab.open("idle");
    await raise(page);

    const dialog = page.getByRole("dialog");
    // All three of these are the question. A dialog that asked "allow?" with
    // no device, no account and no code would be a button, not a decision.
    await expect(dialog).toContainText("Chrome on iOS");
    await expect(dialog).toContainText("someone@example.com");
    await expect(dialog).toContainText("408 315");

    // Announced digit by digit. "Four hundred and eight thousand" is useless
    // for a value being read off another screen one character at a time.
    await expect(page.getByTestId("approval-sas")).toHaveAttribute(
      "aria-label",
      "Verification digits 4 0 8 3 1 5",
    );
  });

  test("says that doing nothing denies it", async ({ page, lab }) => {
    // The countdown is not decoration. A button that silently stops working is
    // worse than one that says when it will, and the default outcome has to be
    // stated or the user cannot know that walking away is safe.
    await lab.open("idle");
    await raise(page);
    await expect(page.getByRole("dialog")).toContainText(
      /Doing nothing denies/,
    );
  });

  test("cannot be dismissed without answering", async ({ page, lab }) => {
    await lab.open("idle");
    await raise(page);
    const dialog = page.getByRole("dialog");

    // Escape, the backdrop, and the absence of a close button. Each is a way
    // to *not answer* that a user would reasonably read as refusing.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();

    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();

    await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
    expect(await answers(page)).toEqual([]);
  });

  test("Deny is one tap, and says no out loud", async ({ page, lab }) => {
    // Denial is sent, not left to the timeout: the requester gets an answer
    // now rather than sitting out a hundred seconds of silence.
    await lab.open("idle");
    await raise(page);
    await page.getByRole("button", { name: "Deny" }).click();
    expect(await answers(page)).toEqual([
      { type: "device:approve", id: REQUEST.id, approved: false },
    ]);
  });

  test("approving sends exactly one answer, however hard it is tapped", async ({
    page,
    lab,
  }) => {
    // A double tap on a laggy link used to send twice, and the second answer
    // came back `APPROVAL_NOT_PENDING` — an error for doing what the UI
    // invited.
    await lab.open("idle");
    await raise(page);
    const approve = page.getByRole("button", { name: "Approve" });
    await approve.click();
    await approve.click({ force: true }).catch(() => {});
    expect(await answers(page)).toEqual([
      { type: "device:approve", id: REQUEST.id, approved: true },
    ]);
  });

  test("Deny holds the focus, so a reflex Enter refuses", async ({
    page,
    lab,
  }) => {
    // The one dialog in the product where a stray keypress grants a stranger a
    // shell. The safe answer is the default answer.
    await lab.open("idle");
    await raise(page);
    await expect(page.getByRole("button", { name: "Deny" })).toBeFocused();
  });

  test("survives the viewport, the tap floor and an axe sweep", async ({
    page,
    lab,
  }, testInfo) => {
    await lab.open("idle");
    await raise(page);

    // Run the sweep's own detectors against this one state. The dialog is the
    // narrowest thing in the app and the only modal that cannot be scrolled
    // away from, so a 390px overflow here hides a decision rather than a label.
    const ctx = {
      page,
      stop: { session: "idle", state: "device-approval" },
      device: testInfo.project.name,
    };
    const findings = [
      ...(await overflow(ctx)),
      ...(await tapTargets(ctx)),
      ...(await a11y(ctx)),
    ];
    expect(
      findings.map((f) => `${f.severity}: ${f.id} — ${f.detail}`),
      `${testInfo.project.name} found defects on the approval dialog`,
    ).toEqual([]);
  });

  test("comes off the screen when the answer can no longer travel", async ({
    page,
    lab,
  }) => {
    // The socket is how the answer gets out, so a dialog left up over a dead
    // connection is a button that does nothing — and by then the relay has
    // already handed the question back to the machine's own prompts.
    await lab.open("idle");
    await raise(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        __mtmuxDeviceApproval?: { getState(): { abandon(): void } };
      };
      w.__mtmuxDeviceApproval!.getState().abandon();
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
