import { useEffect, useCallback, useState, useRef } from "react";
import {
  File,
  Folder,
  FileText,
  FileCode,
  Image,
  ChevronRight,
  Grid3x3,
  List,
  ArrowUpDown,
  Home,
  FilePlus,
  FolderPlus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  ExternalLink,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useAlertStore } from "@/stores/alert-store";
import type { FileEntry } from "@/protocol";
import { useFileStore } from "@/stores/file-store";
import { useSessionStore } from "@/stores/session-store";
import { useUiStore } from "@/stores/ui-store";
import { sendCommand } from "@/lib/send-command";
import { getRelayClient, useRelayClient, useRelaySubscription } from "@/hooks/use-websocket";

function getFileIcon(entry: FileEntry) {
  if (entry.type === "directory") return Folder;
  const ext = entry.name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "go":
    case "rs":
    case "java":
    case "c":
    case "cpp":
    case "rb":
    case "php":
      return FileCode;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
      return Image;
    case "md":
    case "txt":
    case "log":
    case "csv":
      return FileText;
    default:
      return File;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileTreeProps {
  onFileSelect: (path: string) => void;
  className?: string;
  breadcrumbPath?: string;
  onNavigate?: (path: string) => void;
}

export function FileTree({ onFileSelect, className, breadcrumbPath, onNavigate }: FileTreeProps) {
  const {
    currentPath,
    entries,
    viewMode,
    sortBy,
    isLoading,
    isOperating,
    setCurrentPath,
    setViewMode,
    setSortBy,
    setEntries,
    setIsLoading,
    setIsOperating,
    openEditor,
  } = useFileStore();
  const relayClient = useRelayClient();
  const [filter, setFilter] = useState("");
  const [inlineInput, setInlineInput] = useState<{
    type: "file" | "folder" | "rename";
    value: string;
    path?: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    entry: FileEntry;
    x: number;
    y: number;
  } | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);

  const loadDirectory = useCallback(
    (path: string) => {
      const client = getRelayClient();
      if (!client) return;
      setIsLoading(true);
      setCurrentPath(path);
      client.send({ type: "file:list", path });
    },
    [setCurrentPath, setIsLoading],
  );

  useRelaySubscription(
    (msg) => {
      if (msg.type === "file:list") {
        setEntries(msg.entries);
        setIsLoading(false);
      } else if (msg.type === "error") {
        // Don't leave the tree spinning forever if a listing was rejected
        // (e.g. path outside the allow-list).
        setIsLoading(false);
      }
    },
    [setEntries, setIsLoading],
  );

  useEffect(() => {
    loadDirectory(currentPath);
    // relayClient re-runs this once the client attaches / reconnects
  }, [currentPath, loadDirectory, relayClient]);

  // Focus inline input when it appears
  useEffect(() => {
    if (inlineInput) {
      setTimeout(() => inlineInputRef.current?.focus(), 0);
    }
  }, [inlineInput]);

  const handleEntryClick = useCallback(
    (entry: FileEntry) => {
      if (entry.type === "directory") {
        loadDirectory(entry.path);
      } else {
        onFileSelect(entry.path);
      }
    },
    [loadDirectory, onFileSelect],
  );

  const handleNewFile = useCallback(() => {
    setInlineInput({ type: "file", value: "" });
  }, []);

  const handleNewFolder = useCallback(() => {
    setInlineInput({ type: "folder", value: "" });
  }, []);

  const handleUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const uploadFile = useCallback(
    (file: globalThis.File) => {
      const client = getRelayClient();
      if (!client) return;

      setIsOperating(true);
      const filePath = currentPath + "/" + file.name;
      const reader = new FileReader();
      reader.onload = () => {
        const arrayBuffer = reader.result as ArrayBuffer;
        const bytes = new Uint8Array(arrayBuffer);
        const CHUNK_SIZE = 64 * 1024;
        let offset = 0;

        const sendChunk = () => {
          const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
          offset += chunk.length;
          const final = offset >= bytes.length;

          let binary = "";
          for (let i = 0; i < chunk.length; i++) {
            binary += String.fromCharCode(chunk[i]!);
          }
          const base64 = btoa(binary);

          client.send({
            type: "file:upload",
            path: filePath,
            content: base64,
            final,
          });

          if (!final) {
            setTimeout(sendChunk, 0);
          }
        };

        sendChunk();
      };
      reader.readAsArrayBuffer(file);
    },
    [currentPath, setIsOperating],
  );

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      uploadFile(file);
      e.target.value = "";
    },
    [uploadFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        uploadFile(file);
      }
    },
    [uploadFile],
  );

  const handleInlineSubmit = useCallback(() => {
    if (!inlineInput || !inlineInput.value.trim()) {
      setInlineInput(null);
      return;
    }

    const client = getRelayClient();
    if (!client) return;

    setIsOperating(true);
    if (inlineInput.type === "file") {
      client.send({
        type: "file:create",
        path: currentPath + "/" + inlineInput.value.trim(),
      });
    } else if (inlineInput.type === "folder") {
      client.send({
        type: "file:mkdir",
        path: currentPath + "/" + inlineInput.value.trim(),
      });
    } else if (inlineInput.type === "rename" && inlineInput.path) {
      const dir = inlineInput.path.substring(0, inlineInput.path.lastIndexOf("/"));
      client.send({
        type: "file:rename",
        oldPath: inlineInput.path,
        newPath: dir + "/" + inlineInput.value.trim(),
      });
    }

    setInlineInput(null);
  }, [inlineInput, currentPath, setIsOperating]);

  const handleDelete = useCallback(() => {
    if (!deleteTarget) return;
    const client = getRelayClient();
    if (!client) return;
    setIsOperating(true);
    client.send({ type: "file:delete", path: deleteTarget.path });
    setDeleteTarget(null);
  }, [deleteTarget, setIsOperating]);

  const handleRename = useCallback((entry: FileEntry) => {
    setInlineInput({ type: "rename", value: entry.name, path: entry.path });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    setMenuPos(null);
    setContextMenu({ entry, x: e.clientX, y: e.clientY });
  }, []);

  // A tap near the right or bottom edge put the menu off a 375px screen. Clamp
  // once the node exists so the real menu size is known — a ref callback runs
  // in the commit phase, i.e. before paint and never on the server.
  const clampContextMenu = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !contextMenu) return;
      const { width, height } = el.getBoundingClientRect();
      const margin = 8;
      setMenuPos({
        left: Math.max(margin, Math.min(contextMenu.x, window.innerWidth - width - margin)),
        top: Math.max(margin, Math.min(contextMenu.y, window.innerHeight - height - margin)),
      });
    },
    [contextMenu],
  );

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  const handleCdInTerminal = useCallback((path: string) => {
    if (!useSessionStore.getState().activeSessionId) {
      useAlertStore.getState().push("error", "No active session");
      return;
    }
    // `record: false` — a generated `cd` is navigation, not something the
    // user typed, and filling the palette's history with it buries what is.
    if (!sendCommand(`cd ${path}`, { record: false })) return;
    useUiStore.getState().setMobileTab("terminal");
    useAlertStore.getState().push("success", "Navigated to " + path.split("/").pop());
  }, []);

  const sortedEntries = [...entries]
    .filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      switch (sortBy) {
        case "modified":
          return new Date(b.modified).getTime() - new Date(a.modified).getTime();
        case "size":
          return b.size - a.size;
        default:
          return a.name.localeCompare(b.name);
      }
    });

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden",
        isDragging && "ring-2 ring-primary ring-inset",
        className,
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center gap-1 px-2 py-1.5 border-b">
        {breadcrumbPath !== undefined && onNavigate && (
          <div className="flex items-center gap-0.5 shrink-0 overflow-x-auto scrollbar-none mr-1">
            <button
              className="shrink-0 rounded p-0.5 hover:bg-accent"
              onClick={() => onNavigate("/")}
              aria-label="Go to root"
            >
              <Home className="h-3.5 w-3.5" />
            </button>
            {breadcrumbPath
              .split("/")
              .filter(Boolean)
              .map((part, i, arr) => (
                <div key={i} className="flex items-center gap-0.5 shrink-0">
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  <button
                    className={cn(
                      "rounded px-1 py-0.5 hover:bg-accent text-xs",
                      i === arr.length - 1 ? "font-medium" : "text-muted-foreground",
                    )}
                    onClick={() => onNavigate("/" + arr.slice(0, i + 1).join("/"))}
                  >
                    {part}
                  </button>
                </div>
              ))}
          </div>
        )}
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter..."
          className="h-7 text-xs"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => setViewMode(viewMode === "list" ? "grid" : "list")}
          aria-label={viewMode === "list" ? "Switch to grid view" : "Switch to list view"}
        >
          {viewMode === "list" ? (
            <Grid3x3 className="h-3.5 w-3.5" />
          ) : (
            <List className="h-3.5 w-3.5" />
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              aria-label="More actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleNewFile} disabled={isOperating}>
              <FilePlus className="mr-2 h-3.5 w-3.5" />
              New File
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleNewFolder} disabled={isOperating}>
              <FolderPlus className="mr-2 h-3.5 w-3.5" />
              New Folder
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleUpload} disabled={isOperating}>
              <Upload className="mr-2 h-3.5 w-3.5" />
              Upload File
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setSortBy("name")}>
              <ArrowUpDown className="mr-2 h-3.5 w-3.5" />
              Sort by Name {sortBy === "name" && "✓"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSortBy("modified")}>
              <ArrowUpDown className="mr-2 h-3.5 w-3.5" />
              Sort by Modified {sortBy === "modified" && "✓"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSortBy("size")}>
              <ArrowUpDown className="mr-2 h-3.5 w-3.5" />
              Sort by Size {sortBy === "size" && "✓"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Hidden file input for upload */}
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />

      <ScrollArea className="h-0 flex-1">
        {isLoading ? (
          <div className="space-y-1 py-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-1.5">
                <div className="h-4 w-4 animate-pulse rounded bg-muted" />
                <div className="h-4 flex-1 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : viewMode === "list" ? (
          <div className="py-1">
            {/* Inline input for new file/folder */}
            {inlineInput && inlineInput.type !== "rename" && (
              <div className="flex items-center gap-2 px-3 py-1.5">
                {inlineInput.type === "folder" ? (
                  <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FilePlus className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <Input
                  ref={inlineInputRef}
                  value={inlineInput.value}
                  onChange={(e) => setInlineInput({ ...inlineInput, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleInlineSubmit();
                    if (e.key === "Escape") setInlineInput(null);
                  }}
                  onBlur={handleInlineSubmit}
                  placeholder={inlineInput.type === "folder" ? "Folder name..." : "File name..."}
                  className="h-6 text-xs"
                />
              </div>
            )}
            {sortedEntries.map((entry) => {
              const Icon = getFileIcon(entry);
              const isRenaming = inlineInput?.type === "rename" && inlineInput.path === entry.path;

              return (
                <div
                  key={entry.path}
                  className="group flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors"
                  onContextMenu={(e) => handleContextMenu(e, entry)}
                >
                  {isRenaming ? (
                    <>
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <Input
                        ref={inlineInputRef}
                        value={inlineInput!.value}
                        onChange={(e) =>
                          setInlineInput({
                            ...inlineInput!,
                            value: e.target.value,
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleInlineSubmit();
                          if (e.key === "Escape") setInlineInput(null);
                        }}
                        onBlur={handleInlineSubmit}
                        className="h-6 flex-1 text-xs"
                      />
                    </>
                  ) : (
                    <>
                      <button
                        className="flex flex-1 items-center gap-2 min-w-0"
                        onClick={() => handleEntryClick(entry)}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate text-left" title={entry.name}>
                          {entry.name}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {entry.type === "file" ? formatSize(entry.size) : ""}
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                            aria-label="File actions"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {entry.type === "file" && (
                            <DropdownMenuItem onClick={() => openEditor(entry.path)}>
                              <ExternalLink className="mr-2 h-3.5 w-3.5" />
                              Open in Editor
                            </DropdownMenuItem>
                          )}
                          {entry.type === "directory" && (
                            <DropdownMenuItem onClick={() => handleCdInTerminal(entry.path)}>
                              <Terminal className="mr-2 h-3.5 w-3.5" />
                              cd in Terminal
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => handleRename(entry)}>
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setDeleteTarget(entry)}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1 p-2 sm:grid-cols-4">
            {sortedEntries.map((entry) => {
              const Icon = getFileIcon(entry);
              return (
                <button
                  key={entry.path}
                  className="flex flex-col items-center gap-1 rounded-md p-2 hover:bg-accent/50 transition-colors"
                  onClick={() => handleEntryClick(entry)}
                >
                  <Icon className="h-8 w-8 text-muted-foreground" />
                  <span className="text-[10px] truncate w-full text-center">{entry.name}</span>
                </button>
              );
            })}
          </div>
        )}

        {sortedEntries.length === 0 && !isLoading && (
          <div className="flex h-full min-h-[120px] flex-col items-center justify-center py-8 text-center text-sm text-muted-foreground">
            {filter ? "No matching files" : "Empty directory"}
          </div>
        )}
      </ScrollArea>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={clampContextMenu}
          className="fixed z-[var(--z-popover)] min-w-[160px] rounded-md border bg-popover p-1 shadow-md"
          style={{
            top: menuPos?.top ?? contextMenu.y,
            left: menuPos?.left ?? contextMenu.x,
          }}
        >
          {contextMenu.entry.type === "file" && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => {
                openEditor(contextMenu.entry.path);
                setContextMenu(null);
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in Editor
            </button>
          )}
          {contextMenu.entry.type === "directory" && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => {
                handleCdInTerminal(contextMenu.entry.path);
                setContextMenu(null);
              }}
            >
              <Terminal className="h-3.5 w-3.5" />
              cd in Terminal
            </button>
          )}
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              handleRename(contextMenu.entry);
              setContextMenu(null);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-accent"
            onClick={() => {
              setDeleteTarget(contextMenu.entry);
              setContextMenu(null);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone.{" "}
              {deleteTarget?.type === "directory" && "All contents will be deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
