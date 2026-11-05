import { useEffect, useMemo, type SetStateAction } from "react";
import { useExplorerStore } from "./explorer-store";

const EMPTY_FOLDERS: string[] = [];

/** Defaults apply only until this context has saved state, including an empty set. */
export function useExplorerFolders(
  key: string | null,
  defaults: string[] = EMPTY_FOLDERS,
): [ReadonlySet<string>, (update: SetStateAction<ReadonlySet<string>>) => void] {
  const saved = useExplorerStore((state) => (key ? state.folders[key] : undefined));
  useEffect(() => {
    if (key) useExplorerStore.getState().touchTree(key);
  }, [key]);
  const folders = useMemo(() => new Set(saved ?? defaults), [saved, defaults]);
  const setFolders = (update: SetStateAction<ReadonlySet<string>>) => {
    if (!key) return;
    useExplorerStore
      .getState()
      .updateFolders(key, (previous) =>
        typeof update === "function" ? update(previous ?? new Set(defaults)) : update,
      );
  };
  return [folders, setFolders];
}
