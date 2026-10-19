import { afterEach, describe, expect, it } from "vitest";
import { useKeybindingsStore } from "./keybindings-store";
import { bindingsPaused, pauseBindings } from "./recording-pause";
import { handleBindingKey } from "./use-keybindings";

afterEach(() => {
  useKeybindingsStore.getState().setUserEntries([]);
});

function ctrlK() {
  let prevented = false;
  let stopped = false;
  const event = {
    key: "k",
    code: "KeyK",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as KeyboardEvent;
  return { event, swallowed: () => prevented || stopped };
}

describe("pauseBindings", () => {
  it("lets keys through and leaves the keymap alone", () => {
    const before = useKeybindingsStore.getState().keymap;
    const release = pauseBindings();
    expect(bindingsPaused()).toBe(true);
    const press = ctrlK();
    handleBindingKey(press.event);
    expect(press.swallowed()).toBe(false);
    expect(useKeybindingsStore.getState().keymap).toBe(before);
    expect(useKeybindingsStore.getState().keymap.lookup.size).toBeGreaterThan(0);
    release();
    expect(bindingsPaused()).toBe(false);
  });

  it("keeps entries that change during the pause", () => {
    const release = pauseBindings();
    useKeybindingsStore.getState().setUserEntries([{ key: "ctrl+alt+j", command: "lock.now" }]);
    expect(useKeybindingsStore.getState().keymap.lookup.has("ctrl+alt+j")).toBe(true);
    release();
    expect(useKeybindingsStore.getState().keymap.lookup.has("ctrl+alt+j")).toBe(true);
  });

  it("nests, and a second release does nothing", () => {
    const outer = pauseBindings();
    const inner = pauseBindings();
    inner();
    inner();
    expect(bindingsPaused()).toBe(true);
    outer();
    expect(bindingsPaused()).toBe(false);
  });
});
