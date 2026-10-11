import { beforeEach, describe, expect, it } from "vitest";
import {
  SETTINGS_TAB,
  TERMINAL_TAB,
  useMainTabsStore,
} from "./main-tabs-store";

const file = (path: string) => ({ paneId: "%1", path });

beforeEach(() => {
  useMainTabsStore.setState({ tabs: [], active: TERMINAL_TAB });
});

describe("main tabs", () => {
  it("opens settings once and brings it to front", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openSettings();
    tabs.openFile(file("/a.ts"));
    tabs.openSettings();
    const s = useMainTabsStore.getState();
    expect(s.active).toBe(SETTINGS_TAB);
    expect(s.tabs.map((t) => t.id)).toEqual([SETTINGS_TAB, "file:/a.ts"]);
  });

  it("keeps a reopened file in its place", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openFile(file("/a.ts"));
    tabs.openSettings();
    tabs.openFile({ ...file("/a.ts"), size: 10 });
    const s = useMainTabsStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["file:/a.ts", SETTINGS_TAB]);
    expect(s.tabs[0]).toMatchObject({ kind: "file", size: 10 });
    expect(s.active).toBe("file:/a.ts");
  });

  it("closing the front tab lands on a neighbour, then the terminal", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openFile(file("/a.ts"));
    tabs.openSettings();
    tabs.closeTab(SETTINGS_TAB);
    expect(useMainTabsStore.getState().active).toBe("file:/a.ts");
    tabs.closeTab("file:/a.ts");
    expect(useMainTabsStore.getState().active).toBe(TERMINAL_TAB);
  });

  it("drops the oldest tab past twelve", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openSettings();
    for (let i = 0; i < 12; i++) tabs.openFile(file(`/${i}`));
    const ids = useMainTabsStore.getState().tabs.map((t) => t.id);
    expect(ids).toHaveLength(12);
    expect(ids).not.toContain(SETTINGS_TAB);
  });
});
