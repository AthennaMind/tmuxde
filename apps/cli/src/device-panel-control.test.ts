import { describe, expect, it, vi } from "vitest";

import { createDevicePanel } from "./device-panel-control.js";
import { KEY, type KeyReader } from "./keys.js";
import type { LiveView } from "./live-view.js";
import type { ConnectedDevice } from "./serve.js";

/**
 * The panel's behaviour, driven by fake keys against a fake screen.
 *
 * The properties worth pinning are the ones a screenshot cannot show: that a
 * destructive action asks first and a reversible one does not, that an
 * unanswered question cannot be dismissed by a stray key, and that abandoning
 * a question reports "could not ask" rather than "they said no". That last one
 * is the difference between a gate and a formality.
 */

const NOW = 1_700_000_000_000;

function device(over: Partial<ConnectedDevice> = {}): ConnectedDevice {
  return {
    id: "conn-1",
    label: "iPhone",
    connectedAt: NOW - 60_000,
    readOnly: false,
    lastActivityAt: NOW,
    attachedSession: "work",
    tokenId: "tok-1",
    deviceId: "dev-1",
    remoteAddress: "10.0.0.5",
    scope: { kind: "all" },
    ...over,
  };
}

function harness(over: Parameters<typeof createDevicePanel>[0] | object = {}) {
  let press: (key: string) => void = () => {};
  const painted: string[][] = [];
  const logged: string[] = [];

  const view: LiveView = {
    enabled: true,
    log: (...lines) => logged.push(...lines),
    setPanel: (render) => {
      if (render) painted.push(render(90));
    },
    refresh: () => {},
    stop: vi.fn(),
  };
  const keys: KeyReader = {
    enabled: true,
    setHandler: (handler) => {
      press = (key) => handler?.(key);
    },
    stop: vi.fn(),
  };

  const panel = createDevicePanel({
    details: () => [device()],
    hosted: () => true,
    onQuit: vi.fn(),
    now: () => NOW,
    view,
    keys,
    ...over,
  } as Parameters<typeof createDevicePanel>[0]);

  return {
    panel,
    press: (key: string) => press(key),
    /** The most recent frame, stripped of colour. */
    frame: () =>
      (painted.at(-1) ?? [])
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
        .join("\n"),
    logged,
    view,
    keys,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("closing a connection", () => {
  it("does it on one key, because it is reversible", () => {
    // No confirmation. The cost of a wrong close is one reconnect, and a
    // confirmation on the cheap action is what trains people to confirm the
    // expensive one without reading it.
    const disconnect = vi.fn().mockResolvedValue(true);
    const h = harness({ disconnect });
    h.press("c");
    expect(disconnect).toHaveBeenCalledWith("conn-1");
  });

  it("says so, and says it may come back", async () => {
    const h = harness({ disconnect: vi.fn().mockResolvedValue(true) });
    h.press("c");
    await settle();
    expect(h.frame()).toContain("may reconnect");
  });

  it("says plainly when it had already gone", async () => {
    // The panel races the list against a socket closing on its own. Claiming
    // to have closed something that had already left would be a small lie the
    // user could catch.
    const h = harness({ disconnect: vi.fn().mockResolvedValue(false) });
    h.press("c");
    await settle();
    expect(h.frame()).toContain("had already gone");
  });
});

describe("revoking a device", () => {
  it("asks first, because it is not reversible", () => {
    const revoke = vi.fn().mockResolvedValue(true);
    const h = harness({ revoke });
    h.press("r");
    expect(revoke).not.toHaveBeenCalled();
    expect(h.frame()).toContain("Revoke iPhone?");
  });

  it("goes through on y", async () => {
    const revoke = vi.fn().mockResolvedValue(true);
    const h = harness({ revoke });
    h.press("r");
    h.press("y");
    await settle();
    expect(revoke).toHaveBeenCalledWith("dev-1");
    expect(h.frame()).toContain("must pair again");
  });

  it("is abandoned by n, and by Escape", () => {
    const revoke = vi.fn();
    const h = harness({ revoke });
    h.press("r");
    h.press("n");
    expect(revoke).not.toHaveBeenCalled();

    h.press("r");
    h.press(KEY.escape);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("will not offer to revoke the machine's own token", () => {
    const revoke = vi.fn();
    const h = harness({ details: () => [device({ deviceId: null })], revoke });
    h.press("r");
    expect(h.frame()).not.toContain("Revoke");
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("the approval question", () => {
  it("puts the question up and answers yes on y", async () => {
    const h = harness();
    const asked = h.panel.promptForAccess(
      { deviceLabel: "Safari on iPhone", accountEmail: "", via: "code" },
      new AbortController().signal,
    );
    expect(h.frame()).toContain("A device wants in");

    h.press("y");
    await expect(asked).resolves.toEqual({ approved: true });
  });

  it("refuses on n, and says so as a refusal rather than a failure", async () => {
    const h = harness();
    const asked = h.panel.promptForAccess(
      { deviceLabel: "Safari", accountEmail: "", via: "code" },
      new AbortController().signal,
    );
    h.press("n");
    await expect(asked).resolves.toEqual({
      approved: false,
      reason: "refused",
    });
  });

  it("ignores every other key rather than dismissing the question", async () => {
    // A key that takes the question away without answering it is a refusal
    // the user believes they made and the machine never heard.
    const h = harness();
    const asked = h.panel.promptForAccess(
      { deviceLabel: "Safari", accountEmail: "" },
      new AbortController().signal,
    );
    for (const key of ["c", "r", "?", KEY.escape, KEY.up, "l"]) h.press(key);
    expect(h.frame()).toContain("A device wants in");

    h.press("y");
    await expect(asked).resolves.toEqual({ approved: true });
  });

  it("will not quit out from under an unanswered question", async () => {
    const onQuit = vi.fn();
    const h = harness({ onQuit });
    void h.panel.promptForAccess(
      { deviceLabel: "Safari", accountEmail: "" },
      new AbortController().signal,
    );
    h.press("q");
    expect(onQuit).not.toHaveBeenCalled();
  });

  it("abandons rather than refuses when answered elsewhere", async () => {
    // A phone or `mtmux approve` got there first. `decideAccess` reads
    // `no-tty` as "could not ask", which must never be confusable with a no.
    const h = harness();
    const controller = new AbortController();
    const asked = h.panel.promptForAccess(
      { deviceLabel: "Safari", accountEmail: "" },
      controller.signal,
    );
    controller.abort();
    await expect(asked).resolves.toEqual({
      approved: false,
      reason: "no-tty",
    });
    expect(h.frame()).not.toContain("A device wants in");
  });

  it("abandons an open question when the panel stops", async () => {
    const h = harness();
    const asked = h.panel.promptForAccess(
      { deviceLabel: "Safari", accountEmail: "" },
      new AbortController().signal,
    );
    h.panel.stop();
    await expect(asked).resolves.toEqual({
      approved: false,
      reason: "no-tty",
    });
  });
});

describe("the other keys", () => {
  it("shows help, and any key leaves it", () => {
    const h = harness();
    h.press("?");
    expect(h.frame()).toContain("Keys");
    h.press("x");
    expect(h.frame()).toContain("device connected");
  });

  it("re-arms a code only when there is a tunnel", () => {
    const rearm = vi.fn();
    harness({ rearm, hosted: () => false }).press("n");
    expect(rearm).not.toHaveBeenCalled();

    harness({ rearm, hosted: () => true }).press("n");
    expect(rearm).toHaveBeenCalledOnce();
  });

  it("quits on q", () => {
    const onQuit = vi.fn();
    harness({ onQuit }).press("q");
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it("moves the cursor with the arrows", async () => {
    const h = harness({
      details: () => [
        device({ id: "a", label: "First" }),
        device({ id: "b", label: "Second" }),
      ],
      disconnect: vi.fn().mockResolvedValue(true),
    });
    h.press(KEY.down);
    h.press("c");
    await settle();
    // The second row, not the first. A cursor that does not move is a list
    // where only the top entry can ever be acted on.
    expect(h.frame()).toContain("Closed Second");
  });
});

describe("when there is no panel", () => {
  it("abstains from the prompt so the readline one is used", async () => {
    // "Could not ask" and "they said no" have to stay distinguishable, or a
    // machine with no TTY silently refuses every request.
    const view: LiveView = {
      enabled: false,
      log: vi.fn(),
      setPanel: vi.fn(),
      refresh: vi.fn(),
      stop: vi.fn(),
    };
    const panel = createDevicePanel({
      details: () => [],
      hosted: () => false,
      onQuit: vi.fn(),
      view,
    });
    expect(panel.enabled).toBe(false);
    await expect(
      panel.promptForAccess(
        { deviceLabel: "x", accountEmail: "" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ approved: false, reason: "no-tty" });
  });

  it("has no panel against a relay that cannot list connections", () => {
    const view: LiveView = {
      enabled: true,
      log: vi.fn(),
      setPanel: vi.fn(),
      refresh: vi.fn(),
      stop: vi.fn(),
    };
    // An older bundle. Better no panel than an empty one that claims nobody is
    // connected when it simply cannot tell.
    const panel = createDevicePanel({
      hosted: () => false,
      onQuit: vi.fn(),
      view,
    });
    expect(panel.enabled).toBe(false);
  });
});
