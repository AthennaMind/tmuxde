import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ disconnect: () => {} }));
vi.mock("@/lib/relay-registry", () => ({ onDisconnectAll: (fn: () => void) => { fixture.disconnect = fn; } }));
import { relativeFile, useQuickOpenStore } from "./quick-open-store";
import { useMainTabsStore } from "./main-tabs-store";

beforeEach(() => {
  useMainTabsStore.setState({ tabs: [], active: "terminal" });
  useQuickOpenStore.setState({ recent: [] });
});

it("keeps identical paths on different machines and promotes reopened files", () => {
  const open = (machineId: string, path: string) => useMainTabsStore.getState().openFile({ machineId, path, paneId: "%1" });
  open("alpha", "/workspace/readme.md");
  open("beta", "/workspace/readme.md");
  open("alpha", "/workspace/readme.md");
  expect(useQuickOpenStore.getState().recent).toEqual([
    { machineId: "alpha", path: "/workspace/readme.md" },
    { machineId: "beta", path: "/workspace/readme.md" },
  ]);
  useMainTabsStore.getState().openFile({ machineId: "alpha", path: "diff.ts", paneId: "%1", scope: "unstaged" });
  expect(useQuickOpenStore.getState().recent).toHaveLength(2);
});

it("bounds history and clears paths on lock or sign out", () => {
  for (let n = 0; n < 75; n++) useQuickOpenStore.getState().remember({ machineId: "alpha", path: `/root/${n}.ts` });
  expect(useQuickOpenStore.getState().recent).toHaveLength(60);
  fixture.disconnect();
  expect(useQuickOpenStore.getState().recent).toEqual([]);
});

it("scopes recent paths by directory boundaries and rejects traversal", () => {
  expect(relativeFile("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
  expect(relativeFile("/", "/src/a.ts")).toBe("src/a.ts");
  for (const path of ["/repository/a.ts", "/repo", "/repo/../secret", "/repo/./a", "/repo//a"]) {
    expect(relativeFile("/repo", path)).toBeNull();
  }
});
