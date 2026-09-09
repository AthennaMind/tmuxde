import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureInstallPrompt,
  getInstallSnapshot,
  installAvailability,
  isIosDevice,
  markInstalled,
  promptInstall,
  resetInstallPromptForTests,
  subscribeInstall,
  type BeforeInstallPromptEvent,
} from "./install-prompt";

function fakePrompt(outcome: "accepted" | "dismissed") {
  const prompt = vi.fn().mockResolvedValue(undefined);
  return {
    event: {
      prompt,
      userChoice: Promise.resolve({ outcome }),
    } as unknown as BeforeInstallPromptEvent,
    prompt,
  };
}

describe("installAvailability", () => {
  const base = {
    standalone: false,
    hasPrompt: false,
    iosDevice: false,
    secureContext: true,
  };

  it("reports installed whenever the app is already standalone", () => {
    // Even with a prompt still in hand — Chromium sometimes fires
    // beforeinstallprompt in an installed window opened from a link.
    expect(
      installAvailability({ ...base, standalone: true, hasPrompt: true }),
    ).toBe("installed");
  });

  it("prefers the real prompt when the browser gave us one", () => {
    expect(installAvailability({ ...base, hasPrompt: true })).toBe("prompt");
  });

  it("tells an iPhone how to install even over plain http", () => {
    // The LAN self-hosted path is http, and "Add to Home Screen" works there.
    // Ordering this ahead of the secure-context check is what keeps that true.
    expect(
      installAvailability({ ...base, iosDevice: true, secureContext: false }),
    ).toBe("manual");
  });

  it("explains an insecure origin rather than offering a dead button", () => {
    expect(installAvailability({ ...base, secureContext: false })).toBe(
      "insecure",
    );
  });

  it("stays silent on a secure origin that simply never offered a prompt", () => {
    expect(installAvailability(base)).toBe("unavailable");
  });
});

describe("isIosDevice", () => {
  it("recognises an iPhone", () => {
    expect(
      isIosDevice({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" }),
    ).toBe(true);
  });

  it("recognises an iPad behind its desktop user-agent", () => {
    // iPadOS 13+ claims to be a Mac. Touch points are the giveaway.
    expect(
      isIosDevice({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        platform: "MacIntel",
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });

  it("does not mistake a real Mac for an iPad", () => {
    expect(
      isIosDevice({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        platform: "MacIntel",
        maxTouchPoints: 0,
      }),
    ).toBe(false);
  });

  it("does not mistake Android for iOS", () => {
    expect(
      isIosDevice({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)" }),
    ).toBe(false);
  });
});

describe("the deferred prompt singleton", () => {
  beforeEach(() => resetInstallPromptForTests());

  it("starts with nothing to offer", () => {
    expect(getInstallSnapshot()).toEqual({
      hasPrompt: false,
      installed: false,
    });
  });

  it("notifies subscribers when a prompt arrives", () => {
    const listener = vi.fn();
    subscribeInstall(listener);
    captureInstallPrompt(fakePrompt("accepted").event);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getInstallSnapshot().hasPrompt).toBe(true);
  });

  it("returns an identical snapshot when nothing changed", () => {
    // useSyncExternalStore compares by identity and loops forever if the
    // getter allocates, so this is load-bearing rather than cosmetic.
    const first = getInstallSnapshot();
    markInstalled();
    const afterInstall = getInstallSnapshot();
    markInstalled();
    expect(getInstallSnapshot()).toBe(afterInstall);
    expect(first).not.toBe(afterInstall);
  });

  it("consumes the prompt so it cannot be shown twice", async () => {
    const { event, prompt } = fakePrompt("accepted");
    captureInstallPrompt(event);

    await expect(promptInstall()).resolves.toBe("accepted");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(getInstallSnapshot().hasPrompt).toBe(false);

    // Chromium refuses a second prompt() on the same event, so a second call
    // must report that rather than throwing at the caller.
    await expect(promptInstall()).resolves.toBe("unavailable");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("clears the prompt even when the user dismisses it", async () => {
    captureInstallPrompt(fakePrompt("dismissed").event);
    await expect(promptInstall()).resolves.toBe("dismissed");
    expect(getInstallSnapshot().hasPrompt).toBe(false);
  });

  it("reports unavailable rather than throwing when prompt() rejects", async () => {
    const event = {
      prompt: vi.fn().mockRejectedValue(new Error("gesture expired")),
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    } as unknown as BeforeInstallPromptEvent;
    captureInstallPrompt(event);
    await expect(promptInstall()).resolves.toBe("unavailable");
  });

  it("drops a pending prompt once the app is installed", () => {
    captureInstallPrompt(fakePrompt("accepted").event);
    markInstalled();
    expect(getInstallSnapshot()).toEqual({ hasPrompt: false, installed: true });
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    subscribeInstall(listener)();
    captureInstallPrompt(fakePrompt("accepted").event);
    expect(listener).not.toHaveBeenCalled();
  });
});
