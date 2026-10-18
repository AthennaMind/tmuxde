import { useEffect, useState, useCallback, useRef } from "react";
import { X, Save, WrapText, Terminal, AlertTriangle, Lock } from "lucide-react";
import { DownloadButton } from "./transfer-controls";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { cn } from "@/shared/utils";
import { useAlertStore } from "@/shared/alert-store";
import { MonacoEditor } from "./monaco-editor";
import { getMonacoLanguage, getLanguageLabel } from "./file-utils";
import { useFileStore } from "./file-store";
import { useSessionStore } from "@/features/session/session-store";
import { getRelayClient } from "@/features/connection/use-websocket";
import { sendCommand } from "@/features/terminal/send-command";
import { useConnectionStore } from "@/features/connection/connection-store";

/** How long after a save the editor ignores changes to its own file. */
const SAVE_ECHO_MS = 1_500;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function parentFolder(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

export function FileEditor() {
  const { editorFile, editorTruncated, isSaving, closeEditor, setIsSaving } = useFileStore();
  const { activeSessionId } = useSessionStore();
  const connectionStatus = useConnectionStore((s) => s.status);

  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [currentContent, setCurrentContent] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [fileStat, setFileStat] = useState<{
    size: number;
    permissions: string;
    modified: string;
    isWritable: boolean;
  } | null>(null);
  const [wordWrap, setWordWrap] = useState<"on" | "off">("on");
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const unsubRef = useRef<(() => void) | null>(null);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isModified =
    savedContent !== null && currentContent !== null && savedContent !== currentContent;

  // The message handler below lives as long as the file is open. It reads
  // the edit state through refs, so it never sees the state of the render
  // that subscribed it.
  const modifiedRef = useRef(isModified);
  modifiedRef.current = isModified;
  // The content of the save in flight, which becomes the saved content.
  const savingRef = useRef<string | null>(null);
  // Our own save also changes the file on disk. Its event is no news.
  const quietUntilRef = useRef(0);

  // Load file on mount
  useEffect(() => {
    if (!editorFile) return;

    const client = getRelayClient();
    if (!client) return;

    // Reset state
    setSavedContent(null);
    setCurrentContent(null);
    setIsReadOnly(false);
    setFileStat(null);
    setExternalChange(false);
    setLoadError(null);
    savingRef.current = null;
    quietUntilRef.current = 0;

    // Timeout if file:content never arrives
    loadTimeoutRef.current = setTimeout(() => {
      setLoadError("Timed out waiting for file content");
    }, 10_000);

    client.send({ type: "file:read", path: editorFile });
    client.send({ type: "file:stat", path: editorFile });

    const unsub = client.onMessage((msg) => {
      if (msg.type === "file:content" && msg.path === editorFile) {
        if (loadTimeoutRef.current) {
          clearTimeout(loadTimeoutRef.current);
          loadTimeoutRef.current = null;
        }
        setSavedContent(msg.content);
        setCurrentContent(msg.content);
        if (msg.truncated) {
          setIsReadOnly(true);
        }
      }
      if (msg.type === "file:stat" && msg.stat.path === editorFile) {
        setFileStat({
          size: msg.stat.size,
          permissions: msg.stat.permissions,
          modified: msg.stat.modified,
          isWritable: msg.stat.isWritable,
        });
        if (!msg.stat.isWritable) {
          setIsReadOnly(true);
        }
      }
      if (msg.type === "file:write:result" && msg.path === editorFile) {
        setIsSaving(false);
        const written = savingRef.current;
        savingRef.current = null;
        if (msg.success) {
          if (written !== null) setSavedContent(written);
          quietUntilRef.current = Date.now() + SAVE_ECHO_MS;
          useAlertStore.getState().push("success", "File saved");
        } else {
          useAlertStore.getState().push("error", msg.error ?? "Save failed");
        }
      }
      // The watch is on the folder, and the server names files by their
      // real path. The name picks out this file. An editor that saves
      // through a temp file and a rename shows up as add.
      if (
        msg.type === "file:changed" &&
        baseName(msg.path) === baseName(editorFile) &&
        (msg.event === "change" || msg.event === "add") &&
        savingRef.current === null &&
        Date.now() > quietUntilRef.current
      ) {
        if (modifiedRef.current) {
          // Keep the edits. The banner offers a reload.
          setExternalChange(true);
        } else {
          client.send({ type: "file:read", path: editorFile });
        }
      }
    });

    unsubRef.current = unsub;

    return () => {
      unsub();
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
    };
  }, [editorFile]);

  // Establish (and re-establish) the server-side file watch whenever the
  // connection (re)establishes. The relay forgets watches across reconnects,
  // so a watch sent only on mount silently dies after a reconnect and
  // external-change detection stops. Keying this on connection status makes it
  // re-run — and re-issue file:watch — on every successful (re)connect without
  // resetting the editor's content/edit state.
  useEffect(() => {
    if (!editorFile) return;
    if (connectionStatus !== "connected") return;
    const client = getRelayClient();
    if (!client) return;
    // The server watches folders only. Watch the one that holds the file.
    const folder = parentFolder(editorFile);
    client.send({ type: "file:watch", path: folder });
    return () => {
      getRelayClient()?.send({ type: "file:unwatch", path: folder });
    };
  }, [editorFile, connectionStatus]);

  // Monaco binds Ctrl+S once, when it mounts, so the handler it holds is
  // the first one. It reads the file and the text through refs. Reading
  // them from its closure saved the text the file had when it opened.
  const saveTarget = useRef({ editorFile, currentContent, isReadOnly });
  saveTarget.current = { editorFile, currentContent, isReadOnly };
  const handleSave = useCallback(() => {
    const { editorFile: path, currentContent: content, isReadOnly: readOnly } = saveTarget.current;
    if (!path || content === null || readOnly) return;
    const client = getRelayClient();
    if (!client) return;
    setIsSaving(true);
    savingRef.current = content;
    client.send({ type: "file:write", path, content });
  }, [setIsSaving]);

  // Keep unsaved edits visible during navigation or a machine change.
  useEffect(() => {
    if (!isModified) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeSwitch = (event: Event) => {
      if (!window.confirm("Discard unsaved changes and open another machine?")) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("tmuxde:before-workspace-change", beforeSwitch);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("tmuxde:before-workspace-change", beforeSwitch);
    };
  }, [isModified]);

  const handleClose = useCallback(() => {
    if (isModified) {
      setShowDiscardDialog(true);
    } else {
      closeEditor();
    }
  }, [isModified, closeEditor]);

  const handleReload = useCallback(() => {
    if (!editorFile) return;
    const client = getRelayClient();
    if (!client) return;
    client.send({ type: "file:read", path: editorFile });
    setExternalChange(false);
  }, [editorFile]);

  const handleOpenInNewSession = useCallback(() => {
    if (!editorFile) return;
    const client = getRelayClient();
    if (!client) return;
    const dir = editorFile.substring(0, editorFile.lastIndexOf("/"));
    const fileName = editorFile.split("/").pop() ?? "edit";
    client.send({
      type: "session:create",
      name: `edit-${fileName}`,
      cwd: dir,
    });
    closeEditor();
  }, [editorFile, closeEditor]);

  const handleSendToTerminal = useCallback(() => {
    if (!editorFile || !activeSessionId) return;
    if (!sendCommand(`vim ${editorFile}`, { record: false })) return;
    closeEditor();
  }, [editorFile, activeSessionId, closeEditor]);

  if (!editorFile) return null;

  const fileName = editorFile.split("/").pop() ?? "";
  const language = getMonacoLanguage(editorFile);
  const languageLabel = getLanguageLabel(editorFile);

  return (
    <>
      {/* `fixed` escapes AppShell's frame, so this panel carries its own insets. */}
      <div
        // Ctrl with -, = and 0 size the code here. See font-zoom.ts.
        data-zoom-surface="code"
        className="fixed inset-0 z-[var(--z-panel)] flex flex-col bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
      >
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="flex-1 truncate text-sm font-medium">
            {fileName}
            {isModified && (
              <span className="ml-1 text-warning" title="Unsaved changes">
                ●
              </span>
            )}
          </span>
          <Badge variant="secondary" className="text-[10px] shrink-0">
            {languageLabel}
          </Badge>
          <DownloadButton path={editorFile} />
          {(isReadOnly || editorTruncated) && (
            <Badge variant="outline" className="text-[10px] shrink-0 gap-1">
              <Lock className="h-2.5 w-2.5" />
              {editorTruncated ? "Truncated" : "Read-only"}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => setWordWrap((w) => (w === "on" ? "off" : "on"))}
            title="Toggle word wrap"
            aria-label="Toggle word wrap"
          >
            <WrapText className={cn("h-3.5 w-3.5", wordWrap === "on" && "text-primary")} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                aria-label="Terminal actions"
              >
                <Terminal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleOpenInNewSession}>
                Open in new session
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleSendToTerminal} disabled={!activeSessionId}>
                Send to current session (vim)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!isReadOnly && (
            <Button
              variant="default"
              size="sm"
              className="h-7 gap-1 shrink-0"
              onClick={handleSave}
              disabled={!isModified || isSaving}
            >
              <Save className="h-3 w-3" />
              {isSaving ? "Saving..." : "Save"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={handleClose}
            aria-label="Close editor"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* External change banner */}
        {externalChange && (
          <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs">
            <AlertTriangle className="h-3.5 w-3.5 text-warning" />
            <span>File changed on disk.</span>
            <Button variant="outline" size="sm" className="h-6 text-xs" onClick={handleReload}>
              Reload
            </Button>
          </div>
        )}

        {/* Monaco Editor */}
        <div className="flex-1 overflow-hidden">
          {currentContent !== null ? (
            <MonacoEditor
              content={currentContent}
              language={language}
              readOnly={isReadOnly}
              onChange={setCurrentContent}
              onSave={handleSave}
              wordWrap={wordWrap}
            />
          ) : loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <span className="text-sm text-destructive">{loadError}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLoadError(null);
                  const client = getRelayClient();
                  if (client && editorFile) {
                    loadTimeoutRef.current = setTimeout(() => {
                      setLoadError("Timed out waiting for file content");
                    }, 10_000);
                    client.send({ type: "file:read", path: editorFile });
                  }
                }}
              >
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <span className="text-sm text-muted-foreground">Loading...</span>
            </div>
          )}
        </div>

        {/* Status bar */}
        {fileStat && (
          <div className="flex items-center gap-3 border-t px-3 py-1 text-[10px] text-muted-foreground">
            <span>{fileStat.size} bytes</span>
            <span>{fileStat.permissions}</span>
            <span>{new Date(fileStat.modified).toLocaleString()}</span>
          </div>
        )}
      </div>

      {/* Discard confirmation */}
      <AlertDialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes to {fileName}. Are you sure you want to close?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowDiscardDialog(false);
                closeEditor();
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
