import { create } from "zustand";
import type { FileEntry, FileStat } from "@repo/protocol";

interface FileStore {
  currentPath: string;
  // Whether the relay-advertised default path has been applied this session.
  serverPathApplied: boolean;
  entries: FileEntry[];
  selectedFile: string | null;
  fileContent: string | null;
  fileStat: FileStat | null;
  isLoading: boolean;
  viewMode: "list" | "grid";
  sortBy: "name" | "modified" | "size";
  // Editor state
  editorFile: string | null;
  editorTruncated: boolean;
  editorForceText: boolean;
  isOperating: boolean;
  isSaving: boolean;
  setCurrentPath: (path: string) => void;
  /** Apply the relay's advertised default browse path once per session. */
  applyServerDefaultPath: (path: string) => void;
  setEntries: (entries: FileEntry[]) => void;
  setSelectedFile: (path: string | null) => void;
  setFileContent: (content: string | null) => void;
  setFileStat: (stat: FileStat | null) => void;
  setIsLoading: (loading: boolean) => void;
  setViewMode: (mode: "list" | "grid") => void;
  setSortBy: (sort: "name" | "modified" | "size") => void;
  setIsOperating: (operating: boolean) => void;
  openEditor: (path: string) => void;
  openEditorAsText: (path: string) => void;
  closeEditor: () => void;
  setIsSaving: (saving: boolean) => void;
}

export const useFileStore = create<FileStore>((set) => ({
  currentPath: "/home",
  serverPathApplied: false,
  entries: [],
  selectedFile: null,
  fileContent: null,
  fileStat: null,
  isLoading: false,
  viewMode: "list",
  sortBy: "name",
  editorFile: null,
  editorTruncated: false,
  editorForceText: false,
  isOperating: false,
  isSaving: false,
  setCurrentPath: (currentPath) => set({ currentPath }),
  // Only apply once per session so a reconnect's server:info doesn't yank the
  // user back to the home directory after they've navigated elsewhere.
  applyServerDefaultPath: (path) =>
    set((s) =>
      s.serverPathApplied ? s : { currentPath: path, serverPathApplied: true },
    ),
  setEntries: (entries) => set({ entries }),
  setSelectedFile: (selectedFile) => set({ selectedFile }),
  setFileContent: (fileContent) => set({ fileContent }),
  setFileStat: (fileStat) => set({ fileStat }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setViewMode: (viewMode) => set({ viewMode }),
  setSortBy: (sortBy) => set({ sortBy }),
  setIsOperating: (isOperating) => set({ isOperating }),
  openEditor: (path) =>
    set({
      editorFile: path,
      editorTruncated: false,
      editorForceText: false,
      isSaving: false,
    }),
  openEditorAsText: (path) =>
    set({
      editorFile: path,
      editorTruncated: false,
      editorForceText: true,
      isSaving: false,
    }),
  closeEditor: () =>
    set({
      editorFile: null,
      editorTruncated: false,
      editorForceText: false,
      isSaving: false,
    }),
  setIsSaving: (isSaving) => set({ isSaving }),
}));
