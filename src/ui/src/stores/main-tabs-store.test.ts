import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEnrolled } from "@/lib/unlocked";
import {
  SETTINGS_TAB,
  TERMINAL_TAB,
  commitTabId,
  graphTabId,
  restoreTabs,
  useMainTabsStore,
} from "./main-tabs-store";

const file = (path: string) => ({ paneId: "%1", path });
const HASH = "a".repeat(40);
const commit = (subject = "Fix it", hash = HASH) => ({
  paneId: "%1",
  hash,
  subject,
  contextPath: "/repo",
});

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

  it("closes diffs, files or all, never the terminal", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openFile(file("/a.ts"));
    tabs.openFile({ ...file("b.ts"), scope: "unstaged" });
    tabs.openSettings();
    tabs.openFile({ ...file("c.ts"), scope: "staged" });
    tabs.closeTabs("diffs");
    let s = useMainTabsStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["file:/a.ts", SETTINGS_TAB]);
    tabs.closeTabs("files");
    s = useMainTabsStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual([SETTINGS_TAB]);
    tabs.closeTabs("all");
    s = useMainTabsStore.getState();
    expect(s.tabs).toEqual([]);
    expect(s.active).toBe(TERMINAL_TAB);
  });

  it("bulk close keeps the open tab, or lands on a neighbour", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openFile(file("/a.ts"));
    tabs.openFile({ ...file("b.ts"), scope: "unstaged" });
    tabs.openFile(file("/c.ts"));
    tabs.openFile({ ...file("d.ts"), scope: "staged" });
    tabs.activate("file:/c.ts");
    tabs.closeTabs("diffs");
    expect(useMainTabsStore.getState().active).toBe("file:/c.ts");
    tabs.openFile({ ...file("e.ts"), scope: "staged" });
    tabs.openFile(file("/f.ts"));
    tabs.activate("staged:e.ts");
    tabs.closeTabs("diffs");
    // Next after it first.
    expect(useMainTabsStore.getState().active).toBe("file:/f.ts");
    tabs.openFile({ ...file("g.ts"), scope: "untracked" });
    tabs.closeTabs("diffs");
    // Nothing after it, so the one before.
    expect(useMainTabsStore.getState().active).toBe("file:/f.ts");
    tabs.openSettings();
    tabs.showTerminal();
    tabs.closeTabs("files");
    // The terminal was open and stays open.
    const s = useMainTabsStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual([SETTINGS_TAB]);
    expect(s.active).toBe(TERMINAL_TAB);
  });

  it("opens a commit once and keeps a subject a parent link lacks", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openCommit(commit());
    tabs.openFile(file("/a.ts"));
    tabs.openCommit(commit(""));
    const s = useMainTabsStore.getState();
    expect(s.active).toBe(commitTabId(HASH));
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[0]).toMatchObject({ kind: "commit", subject: "Fix it" });
  });

  it("names a commit tab without bringing it to front", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openCommit(commit(""));
    tabs.openFile(file("/a.ts"));
    tabs.nameCommit(HASH, "Loaded subject");
    tabs.nameCommit("b".repeat(40), "Not open");
    const s = useMainTabsStore.getState();
    expect(s.active).toBe("file:/a.ts");
    expect(s.tabs[0]).toMatchObject({ subject: "Loaded subject" });
    expect(s.tabs).toHaveLength(2);
  });

  it("closes commits with diffs", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openFile(file("/a.ts"));
    tabs.openCommit(commit());
    tabs.closeTabs("files");
    expect(useMainTabsStore.getState().tabs.map((t) => t.id)).toEqual([
      commitTabId(HASH),
    ]);
    tabs.closeTabs("diffs");
    expect(useMainTabsStore.getState()).toMatchObject({
      tabs: [],
      active: TERMINAL_TAB,
    });
  });

  it("opens one graph per repository and refreshes its pane", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openGraph({ paneId: "%1", contextPath: "/repo" });
    tabs.openFile(file("/a.ts"));
    tabs.openGraph({ paneId: "%2", contextPath: "/repo" });
    tabs.openGraph({ paneId: "%2", contextPath: "/other" });
    const s = useMainTabsStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual([
      graphTabId("/repo"),
      "file:/a.ts",
      graphTabId("/other"),
    ]);
    expect(s.tabs[0]).toEqual({
      kind: "graph",
      id: "graph:/repo",
      paneId: "%2",
      contextPath: "/repo",
    });
    expect(s.active).toBe(graphTabId("/other"));
  });

  it("closes graphs with all only", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openGraph({ paneId: "%1", contextPath: "/repo" });
    tabs.openCommit(commit());
    tabs.openFile(file("/a.ts"));
    tabs.closeTabs("diffs");
    tabs.closeTabs("files");
    expect(useMainTabsStore.getState()).toMatchObject({
      tabs: [{ id: graphTabId("/repo") }],
      active: graphTabId("/repo"),
    });
    tabs.closeTabs("all");
    expect(useMainTabsStore.getState()).toMatchObject({
      tabs: [],
      active: TERMINAL_TAB,
    });
  });

  it("drops the oldest file past twelve and keeps settings", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openSettings();
    for (let i = 0; i < 12; i++) tabs.openFile(file(`/${i}`));
    const ids = useMainTabsStore.getState().tabs.map((t) => t.id);
    expect(ids).toHaveLength(12);
    expect(ids[0]).toBe(SETTINGS_TAB);
    expect(ids).not.toContain("file:/0");
    expect(ids).toContain("file:/11");
  });

  it("keeps a graph while commits opened from it fill the strip", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openGraph({ paneId: "%1", contextPath: "/repo" });
    for (let i = 0; i < 12; i++) {
      // Back to the graph, then open the next commit from it.
      tabs.activate(graphTabId("/repo"));
      tabs.openCommit(commit(`c${i}`, i.toString(16).padStart(40, "0")));
    }
    const s = useMainTabsStore.getState();
    expect(s.tabs).toHaveLength(12);
    expect(s.tabs[0]!.id).toBe(graphTabId("/repo"));
    expect(s.tabs.map((t) => t.id)).not.toContain(commitTabId("0".repeat(40)));
    expect(s.active).toBe(commitTabId("b".padStart(40, "0")));
  });

  it("keeps three graphs while commits opened from one fill the strip", () => {
    const tabs = useMainTabsStore.getState();
    for (const root of ["/a", "/b", "/c"])
      tabs.openGraph({ paneId: "%1", contextPath: root });
    for (let i = 0; i < 10; i++) {
      tabs.activate(graphTabId("/a"));
      tabs.openCommit(commit(`c${i}`, i.toString(16).padStart(40, "0")));
    }
    const ids = useMainTabsStore.getState().tabs.map((t) => t.id);
    expect(ids).toHaveLength(12);
    expect(ids.slice(0, 3)).toEqual(["/a", "/b", "/c"].map(graphTabId));
    expect(ids).not.toContain(commitTabId("0".repeat(40)));
  });

  it("keeps the tab in front even when it is the oldest", () => {
    const tabs = useMainTabsStore.getState();
    tabs.openFile(file("/front.ts"));
    for (let i = 0; i < 11; i++) tabs.openFile(file(`/${i}`));
    tabs.activate("file:/front.ts");
    tabs.openCommit(commit());
    const ids = useMainTabsStore.getState().tabs.map((t) => t.id);
    expect(ids).toHaveLength(12);
    expect(ids[0]).toBe("file:/front.ts");
    expect(ids).not.toContain("file:/0");
    expect(ids.at(-1)).toBe(commitTabId(HASH));
  });

  it("drops a graph only when nothing else can go", () => {
    const tabs = useMainTabsStore.getState();
    for (let i = 0; i < 13; i++)
      tabs.openGraph({ paneId: "%1", contextPath: `/r${i}` });
    const ids = useMainTabsStore.getState().tabs.map((t) => t.id);
    expect(ids).toHaveLength(12);
    expect(ids).not.toContain(graphTabId("/r0"));
    expect(ids.at(-1)).toBe(graphTabId("/r12"));
  });
});

describe("restoreTabs", () => {
  it("keeps well formed tabs and the active one", () => {
    const restored = restoreTabs({
      tabs: [
        { kind: "file", id: "file:/a.ts", paneId: "%1", path: "/a.ts" },
        { kind: "settings", id: SETTINGS_TAB },
      ],
      active: "file:/a.ts",
    });
    expect(restored.tabs.map((t) => t.id)).toEqual(["file:/a.ts", SETTINGS_TAB]);
    expect(restored.active).toBe("file:/a.ts");
  });

  it("drops malformed tabs and an active id that names none", () => {
    const restored = restoreTabs({
      tabs: [
        { kind: "file", id: "file:/b.ts", paneId: "%1", path: "/a.ts" },
        { kind: "file", id: "file:/c.ts", path: "/c.ts" },
        { kind: "other", id: "x" },
        null,
      ],
      active: "file:/b.ts",
    });
    expect(restored).toEqual({ tabs: [], active: TERMINAL_TAB });
  });

  it("restores commit tabs with a full hash only", () => {
    const tab = { kind: "commit", id: commitTabId(HASH), ...commit() };
    const restored = restoreTabs({
      tabs: [
        tab,
        { ...tab, hash: "abc1234", id: commitTabId("abc1234") },
        { ...tab, id: "commit:other" },
        { ...tab, hash: "b".repeat(40), id: commitTabId("b".repeat(40)), subject: undefined },
      ],
      active: tab.id,
    });
    expect(restored.tabs.map((t) => t.id)).toEqual([tab.id]);
    expect(restored.active).toBe(tab.id);
  });

  it("restores graph tabs with an absolute folder and a matching id", () => {
    const tab = {
      kind: "graph",
      id: graphTabId("/repo"),
      paneId: "%1",
      contextPath: "/repo",
    };
    const restored = restoreTabs({
      tabs: [
        tab,
        { ...tab, id: "graph:/elsewhere" },
        { ...tab, id: graphTabId("repo"), contextPath: "repo" },
        { ...tab, id: graphTabId("/x"), contextPath: "/x", paneId: 3 },
      ],
      active: tab.id,
    });
    expect(restored.tabs.map((t) => t.id)).toEqual([tab.id]);
    expect(restored.active).toBe(tab.id);
  });

  it("trims a long stored strip the way opening a tab does", () => {
    const graph = {
      kind: "graph",
      id: graphTabId("/repo"),
      paneId: "%1",
      contextPath: "/repo",
    };
    const files = Array.from({ length: 13 }, (_, i) => ({
      kind: "file",
      id: `file:/${i}`,
      paneId: "%1",
      path: `/${i}`,
    }));
    const restored = restoreTabs({
      tabs: [graph, ...files],
      active: "file:/0",
    });
    expect(restored.tabs.map((t) => t.id)).toEqual([
      graph.id,
      "file:/0",
      ...files.slice(3).map((f) => f.id),
    ]);
    expect(restored.active).toBe("file:/0");
  });

  it("survives nothing stored", () => {
    expect(restoreTabs(undefined)).toEqual({ tabs: [], active: TERMINAL_TAB });
  });
});

describe("tab persistence", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  const KEY = "tmuxde-main-tabs";

  beforeEach(() => {
    local.clear();
    session.clear();
    vi.stubGlobal("window", { localStorage: local, sessionStorage: session });
  });

  afterEach(() => {
    setEnrolled(false);
    vi.unstubAllGlobals();
  });

  it("comes back after a reload", async () => {
    useMainTabsStore.getState().openFile(file("/a.ts"));
    const saved = local.getItem(KEY);
    // A reload starts from empty memory and finds what was saved.
    useMainTabsStore.setState({ tabs: [], active: TERMINAL_TAB });
    local.setItem(KEY, saved!);
    await useMainTabsStore.persist.rehydrate();
    const s = useMainTabsStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["file:/a.ts"]);
    expect(s.active).toBe("file:/a.ts");
  });

  it("keeps paths out of localStorage once a lock is enrolled", () => {
    useMainTabsStore.getState().openFile(file("/a.ts"));
    expect(local.getItem(KEY)).not.toBeNull();
    setEnrolled(true);
    useMainTabsStore.getState().openFile(file("/b.ts"));
    expect(local.getItem(KEY)).toBeNull();
    expect(session.getItem(KEY)).toContain("/b.ts");
  });
});

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}
