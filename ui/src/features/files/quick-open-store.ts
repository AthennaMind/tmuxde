import { create } from "zustand";
import { onDisconnectAll } from "@/features/connection/relay-registry";
import { useMainTabsStore } from "@/features/workspace/main-tabs-store";

export interface RecentFile {
  machineId: string;
  path: string;
}

export function relativeFile(root: string, path: string): string | null {
  const prefix = root === "/" ? "/" : `${root.replace(/\/$/, "")}/`;
  if (!path.startsWith(prefix)) return null;
  const relative = path.slice(prefix.length);
  return relative && !relative.split("/").some((part) => part === ".." || part === "." || !part)
    ? relative
    : null;
}

export const useQuickOpenStore = create<{
  recent: RecentFile[];
  remember: (file: RecentFile) => void;
}>((set) => ({
  recent: [],
  remember: (file) =>
    set((state) => ({
      recent: [
        file,
        ...state.recent.filter(
          (entry) => entry.machineId !== file.machineId || entry.path !== file.path,
        ),
      ].slice(0, 60),
    })),
}));

// Track file opens from every entry point. Paths stay in memory only.
useMainTabsStore.subscribe((state, previous) => {
  if (state.active === previous.active && state.tabs === previous.tabs) return;
  const tab = state.tabs.find((item) => item.id === state.active);
  if (tab?.kind === "file" && !tab.scope) {
    useQuickOpenStore.getState().remember({ machineId: tab.machineId ?? "local", path: tab.path });
  }
});

onDisconnectAll(() => useQuickOpenStore.setState({ recent: [] }));
