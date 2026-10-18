import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ClientMessage } from "@/protocol";

const sent: ClientMessage[] = [];
const client = {
  status: "connected" as string,
  send: (msg: ClientMessage) => {
    sent.push(msg);
  },
};
let currentClient: typeof client | null = client;

vi.mock("@/features/connection/use-websocket", () => ({
  getRelayClient: () => currentClient,
}));

import {
  awaitingScrollStateProbe,
  flushScroll,
  leaveCopyMode,
  noteScrollStateReply,
  requestScrollState,
  resetScrollState,
  scrollByLines,
  scrollToPosition,
  SCROLL_FLUSH_MS,
} from "./terminal-scroll";
import {
  believedInCopyMode,
  noteEnteredCopyMode,
  resetCopyModeBeliefForTests,
} from "./copy-mode-belief";
import { useSessionStore } from "@/features/session/session-store";

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  currentClient = client;
  client.status = "connected";
  resetScrollState();
  resetCopyModeBeliefForTests();
  useSessionStore.getState().setActiveSession("work");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scrollByLines", () => {
  it("coalesces a burst into one message", () => {
    scrollByLines(3);
    scrollByLines(3);
    scrollByLines(-1);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(SCROLL_FLUSH_MS);
    expect(sent).toEqual([{ type: "tmux:scroll", lines: 5 }]);
  });

  it("clamps a violent flick instead of having it rejected by the schema", () => {
    scrollByLines(9000);
    vi.advanceTimersByTime(SCROLL_FLUSH_MS);
    expect(sent).toEqual([{ type: "tmux:scroll", lines: 500 }]);
  });

  it("sends nothing, and believes nothing, while the socket is down", () => {
    client.status = "reconnecting";
    scrollByLines(5);
    vi.advanceTimersByTime(SCROLL_FLUSH_MS);
    expect(sent).toHaveLength(0);
    expect(believedInCopyMode("work")).toBe(false);
  });

  it("sends nothing with no session attached, which would only be an error", () => {
    useSessionStore.getState().setActiveSession(null);
    scrollByLines(5);
    vi.advanceTimersByTime(SCROLL_FLUSH_MS);
    expect(sent).toHaveLength(0);
  });

  it("goes out at once when a drag ends rather than waiting out the timer", () => {
    scrollByLines(6);
    flushScroll();
    expect(sent).toEqual([{ type: "tmux:scroll", lines: 6 }]);
    // And the timer it cancelled does not fire a second, empty message.
    vi.advanceTimersByTime(SCROLL_FLUSH_MS * 2);
    expect(sent).toHaveLength(1);
  });

  it("notes copy mode once the scroll is actually on the wire", () => {
    scrollByLines(5);
    expect(believedInCopyMode("work")).toBe(false);
    vi.advanceTimersByTime(SCROLL_FLUSH_MS);
    expect(believedInCopyMode("work")).toBe(true);
  });

  it("uses relay reports instead of assuming TUI scrolling enters copy mode", () => {
    noteScrollStateReply(false);
    scrollByLines(5);
    flushScroll();
    expect(believedInCopyMode("work")).toBe(false);
    noteScrollStateReply(true);
    expect(believedInCopyMode("work")).toBe(true);
    noteScrollStateReply(false);
    expect(believedInCopyMode("work")).toBe(false);
  });
});

describe("scrollToPosition", () => {
  it("goes out immediately and drops the relative lines it overrides", () => {
    scrollByLines(4);
    scrollToPosition(120);
    vi.advanceTimersByTime(SCROLL_FLUSH_MS * 4);
    expect(sent).toEqual([{ type: "tmux:scroll-to", position: 120 }]);
  });

  it("never asks for a negative position", () => {
    scrollToPosition(-7);
    expect(sent).toEqual([{ type: "tmux:scroll-to", position: 0 }]);
  });
});

describe("requestScrollState", () => {
  it("asks only when there is something to ask about", () => {
    requestScrollState();
    expect(sent).toEqual([{ type: "tmux:scroll-state" }]);

    sent.length = 0;
    currentClient = null;
    requestScrollState();
    expect(sent).toHaveLength(0);
  });

  it("stops asking a relay too old to answer, and stops scrolling it too", () => {
    requestScrollState();
    expect(awaitingScrollStateProbe()).toBe(true);
    // An older relay rejects the message instead of answering it. Silence is
    // read the same way, which is what this timeout is.
    vi.advanceTimersByTime(5000);
    expect(awaitingScrollStateProbe()).toBe(false);

    sent.length = 0;
    requestScrollState();
    scrollToPosition(40);
    expect(sent).toHaveLength(0);
  });

  it("keeps asking once a relay has answered", () => {
    requestScrollState();
    noteScrollStateReply();
    expect(awaitingScrollStateProbe()).toBe(false);
    vi.advanceTimersByTime(10_000);

    sent.length = 0;
    requestScrollState();
    scrollToPosition(40);
    expect(sent).toEqual([{ type: "tmux:scroll-state" }, { type: "tmux:scroll-to", position: 40 }]);
  });

  it("still scrolls an old relay by lines, which it has always understood", () => {
    requestScrollState();
    vi.advanceTimersByTime(5000);
    sent.length = 0;
    scrollByLines(4);
    vi.advanceTimersByTime(SCROLL_FLUSH_MS);
    expect(sent).toEqual([{ type: "tmux:scroll", lines: 4 }]);
  });
});

describe("leaveCopyMode", () => {
  it("sends the exit when the active session is believed in copy mode", () => {
    // A click on the desktop terminal after scrolling back. Typing went
    // nowhere while the pane stayed in copy mode.
    noteEnteredCopyMode("work");
    expect(leaveCopyMode()).toBe(true);
    expect(sent).toEqual([{ type: "tmux:exit-copy-mode" }]);
    expect(believedInCopyMode("work")).toBe(false);
  });

  it("sends nothing outside copy mode", () => {
    expect(leaveCopyMode()).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("drops wheel lines not sent yet, so they do not scroll back in", () => {
    noteEnteredCopyMode("work");
    scrollByLines(5);
    leaveCopyMode();
    vi.advanceTimersByTime(SCROLL_FLUSH_MS * 4);
    expect(sent).toEqual([{ type: "tmux:exit-copy-mode" }]);
  });

  it("sends nothing while disconnected", () => {
    noteEnteredCopyMode("work");
    client.status = "reconnecting";
    expect(leaveCopyMode()).toBe(false);
    expect(sent).toHaveLength(0);
    expect(believedInCopyMode("work")).toBe(true);
  });
});
