import { describe, expect, it } from "vitest";
import { TERMINAL_TAB } from "./main-tabs-store";
import { neighbourView, terminalViewId, viewOrder, type ViewState } from "./view-step";

const DEV = { machineId: "local", sessionName: "dev" };
const OPS = { machineId: "alpha", sessionName: "ops" };

function state(partial: Partial<ViewState>): ViewState {
  return {
    order: [],
    terminals: [DEV, OPS],
    tabIds: ["settings", "file:/a.ts"],
    active: TERMINAL_TAB,
    activeMachine: "local",
    activeSession: "dev",
    ...partial,
  };
}

describe("viewOrder", () => {
  it("lists terminals then tabs, and finds the terminal showing now", () => {
    expect(viewOrder(state({}))).toEqual({
      order: [terminalViewId(DEV), terminalViewId(OPS), "settings", "file:/a.ts"],
      current: terminalViewId(DEV),
    });
  });

  it("keeps the dragged order and appends new views", () => {
    const { order } = viewOrder(
      state({ order: ["file:/a.ts", terminalViewId(OPS), "closed"], active: "file:/a.ts" }),
    );
    expect(order).toEqual(["file:/a.ts", terminalViewId(OPS), terminalViewId(DEV), "settings"]);
  });

  it("names a tab as current, or nothing the strip lacks", () => {
    expect(viewOrder(state({ active: "settings" })).current).toBe("settings");
    expect(viewOrder(state({ activeSession: null })).current).toBeNull();
    expect(viewOrder(state({ activeMachine: "beta" })).current).toBeNull();
  });
});

describe("neighbourView", () => {
  const order = ["a", "b", "c"];

  it("steps both ways and wraps at the ends", () => {
    expect(neighbourView(order, "b", 1)).toBe("c");
    expect(neighbourView(order, "b", -1)).toBe("a");
    expect(neighbourView(order, "c", 1)).toBe("a");
    expect(neighbourView(order, "a", -1)).toBe("c");
  });

  it("starts at an end without a current view", () => {
    expect(neighbourView(order, null, 1)).toBe("a");
    expect(neighbourView(order, null, -1)).toBe("c");
    expect(neighbourView([], null, 1)).toBeNull();
  });

  it("goes nowhere from the only view", () => {
    expect(neighbourView(["a"], "a", 1)).toBeNull();
    expect(neighbourView(["a"], "a", -1)).toBeNull();
  });
});
