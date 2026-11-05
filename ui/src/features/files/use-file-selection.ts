import { useCallback, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { FileEntry } from "@/protocol";
import type { RepositoryClient } from "@/features/repository/repository-request";
import { EMPTY_FILE_SELECTION, selectFile } from "./file-selection";

export function useFileSelection(
  tree: RefObject<HTMLDivElement | null>,
  client: RepositoryClient | null,
  machine: string,
  paneId: string | null,
  root: string | null,
) {
  const entries = useRef(new Map<string, FileEntry>());
  const [selection, setSelection] = useState(EMPTY_FILE_SELECTION);
  const [scope, setScope] = useState({ client, machine, paneId, root });
  if (
    scope.client !== client ||
    scope.machine !== machine ||
    scope.paneId !== paneId ||
    scope.root !== root
  ) {
    setScope({ client, machine, paneId, root });
    setSelection(EMPTY_FILE_SELECTION);
  }

  const registerEntry = useCallback((entry: FileEntry) => {
    entries.current.set(entry.path, entry);
  }, []);
  const forgetEntry = useCallback((path: string) => {
    entries.current.delete(path);
    setSelection((previous) => {
      if (!previous.paths.has(path) && previous.anchor !== path) return previous;
      const paths = new Set(previous.paths);
      paths.delete(path);
      return { paths, anchor: previous.anchor === path ? null : previous.anchor };
    });
  }, []);
  const clear = useCallback(() => setSelection(EMPTY_FILE_SELECTION), []);
  const visiblePaths = () =>
    Array.from(tree.current?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? [])
      .map((row) => row.dataset.treeRow!)
      .filter((path) => entries.current.has(path));

  const select = (path: string, modifiers: { range?: boolean; additive?: boolean } = {}) => {
    const visible = visiblePaths();
    setSelection((previous) => selectFile(previous, path, visible, modifiers));
  };
  const contextSelect = (entry: FileEntry) => {
    setSelection((previous) =>
      previous.paths.has(entry.path)
        ? previous
        : { paths: new Set([entry.path]), anchor: entry.path },
    );
  };
  const selectedEntries = (fallback?: FileEntry) => {
    if (fallback && !selection.paths.has(fallback.path)) return [fallback];
    return [...selection.paths].flatMap((path) => {
      const entry = entries.current.get(path);
      return entry ? [entry] : [];
    });
  };
  const onKeyDownCapture = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const path = target.dataset.treeRow;
    if (!path || event.altKey || event.defaultPrevented) return;
    const additive = event.ctrlKey || event.metaKey;
    if (additive && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection({ paths: new Set(visiblePaths()), anchor: path });
    } else if (event.key === "Escape") {
      event.preventDefault();
      clear();
    } else if (event.key === " ") {
      event.preventDefault();
      select(path, { additive, range: event.shiftKey });
    }
  };
  const onNavigate = (event: KeyboardEvent, navigate: (event: KeyboardEvent) => void) => {
    const target = event.target as HTMLElement;
    if (!target.dataset.treeRow) return;
    const path = target.dataset.treeRow;
    navigate(event);
    if (
      !event.defaultPrevented ||
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
      event.altKey ||
      ((event.ctrlKey || event.metaKey) && !event.shiftKey)
    )
      return;
    const next = (document.activeElement as HTMLElement | null)?.dataset.treeRow;
    if (!next) return;
    const visible = visiblePaths();
    setSelection((previous) =>
      selectFile(
        event.shiftKey && !previous.anchor ? { ...previous, anchor: path } : previous,
        next,
        visible,
        { range: event.shiftKey, additive: event.ctrlKey || event.metaKey },
      ),
    );
  };

  return {
    paths: selection.paths,
    registerEntry,
    forgetEntry,
    clear,
    select,
    contextSelect,
    selectedEntries,
    onKeyDownCapture,
    onNavigate,
  };
}
