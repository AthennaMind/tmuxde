import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  believedInCopyMode,
  noteEnteredCopyMode,
  noteLeftCopyMode,
  resetCopyModeBeliefForTests,
  subscribeCopyModeBelief,
} from "./copy-mode-belief";

/**
 * The belief became something the screen renders from, which is a stricter
 * contract than "a Set somebody checks later". A missed notification is a
 * toolbar that still says the terminal is typeable while tmux eats every key.
 */

beforeEach(() => resetCopyModeBeliefForTests());

describe("copy-mode belief", () => {
  it("tells subscribers when a session enters and leaves", () => {
    const seen = vi.fn();
    subscribeCopyModeBelief(seen);

    noteEnteredCopyMode("work");
    expect(believedInCopyMode("work")).toBe(true);
    noteLeftCopyMode("work");
    expect(believedInCopyMode("work")).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when nothing actually changed", () => {
    // A drag emits one of these per burst of scrolling. Notifying on every
    // repeat would re-render the toolbar for the length of the gesture.
    noteEnteredCopyMode("work");
    const seen = vi.fn();
    subscribeCopyModeBelief(seen);

    noteEnteredCopyMode("work");
    noteLeftCopyMode("other");
    expect(seen).not.toHaveBeenCalled();
  });

  it("stops after unsubscribing", () => {
    const seen = vi.fn();
    subscribeCopyModeBelief(seen)();
    noteEnteredCopyMode("work");
    expect(seen).not.toHaveBeenCalled();
  });

  it("keeps sessions apart", () => {
    // The bug a single boolean had: scrolling in one session and tapping in
    // another told the wrong one to leave.
    noteEnteredCopyMode("work");
    expect(believedInCopyMode("other")).toBe(false);
  });
});
