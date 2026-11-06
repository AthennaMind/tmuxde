import { useEffect, useRef, useState } from "react";
import {
  ClipboardCopy,
  FileCode,
  FileDiff,
  FolderOpen,
  Plus,
  Undo2,
  Minus,
  Trash2,
} from "lucide-react";
import { useRelayClient } from "@/features/connection/use-websocket";
import { isReadOnly, useConnectionStore } from "@/features/connection/connection-store";
import { machineId } from "@/features/connection/machine-context";
import { usePaneStore } from "@/features/panes/pane-store";
import { useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { useUiStore } from "@/features/workspace/ui-store";
import { explorerTreeKey, useExplorerStore } from "@/features/workspace/explorer-store";
import { useFileStore } from "@/features/files/file-store";
import { isMobileViewport } from "@/shared/mobile-query";
import { copyFailureReason, copyText } from "@/shared/clipboard";
import { useAlertStore } from "@/shared/alert-store";
import {
  mutateChanges,
  changePath,
  type ChangeEntry,
  type ChangeMutation,
  type ChangeScope,
  type ChangeTarget,
} from "./change-actions";
import type { ChangeMenuAction } from "./change-context-menu";

export function useChangeActions(
  root: string,
  workdir: string,
  onOpen: (path: string, scope: ChangeScope) => void,
) {
  const client = useRelayClient();
  const paneId = usePaneStore((s) => s.activePaneId);
  const connection = useConnectionStore((s) => s.status);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const supported = useConnectionStore((s) => s.features.has("repo:mutate"));
  const machine = machineId();
  const [confirmation, setConfirmation] = useState<ChangeTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  if (
    confirmation &&
    (confirmation.client !== client ||
      confirmation.machine !== machine ||
      confirmation.root !== root ||
      confirmation.workdir !== workdir)
  )
    setConfirmation(null);
  useEffect(() => {
    const cancel = () => request.current?.abort();
    window.addEventListener("tmuxde:before-workspace-change", cancel);
    return () => {
      cancel();
      window.removeEventListener("tmuxde:before-workspace-change", cancel);
    };
  }, [client, machine, root, workdir]);
  const writable = !isReadOnly(capabilities) && (!capabilities || capabilities.files === "write");
  const available =
    writable && supported && connection === "connected" && !!paneId && !!client && !pending;

  const run = async (action: ChangeMutation, target: ChangeTarget) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setCompleted(0);
    setError(null);
    let count = 0;
    try {
      await mutateChanges(target, action, controller.signal, (value) => {
        count = value;
        setCompleted(value);
      });
      if (!controller.signal.aborted) {
        setConfirmation(null);
        useAlertStore
          .getState()
          .push(
            "success",
            `${count} file${count === 1 ? "" : "s"} ${action === "stage" ? "staged" : action === "unstage" ? "unstaged" : target.scope === "untracked" ? "deleted" : "restored"}`,
          );
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error ? cause.message : "Could not change files.";
        setError(message);
        if (action !== "discard")
          useAlertStore
            .getState()
            .push("error", `${count > 0 ? `${count} files changed. ` : ""}${message}`);
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
        if (!controller.signal.aborted)
          requestAnimationFrame(() => {
            if (document.activeElement !== document.body) return;
            const row = document.querySelector<HTMLElement>(
              `[data-change-path="${CSS.escape(target.path)}"]`,
            );
            (row ?? document.querySelector<HTMLElement>("[data-changes-list]"))?.focus({
              preventScroll: true,
            });
          });
      }
    }
  };

  const copy = async (value: string) => {
    if (await copyText(value)) useAlertStore.getState().push("success", "Path copied");
    else useAlertStore.getState().push("error", copyFailureReason());
  };
  const menu = (
    entries: ChangeEntry[],
    scope: ChangeScope,
    path: string,
    folder = false,
  ): ChangeMenuAction[] => {
    const full = changePath(root, path);
    const deleted =
      !folder && (scope === "staged" ? entries[0]?.index : entries[0]?.worktree) === "D";
    const target =
      client && paneId ? { client, machine, paneId, root, workdir, entries, scope, path } : null;
    const actions: ChangeMenuAction[] = [];
    if (!folder)
      actions.push(
        {
          label: "Open file",
          icon: FileCode,
          disabled: deleted || !paneId,
          onSelect: () => {
            if (paneId) {
              useMainTabsStore.getState().openFile({ paneId, path: full });
              useUiStore.getState().setMobileTab("terminal");
            }
          },
        },
        { label: "Open changes", icon: FileDiff, onSelect: () => onOpen(path, scope) },
      );
    actions.push(
      {
        label: "Reveal in Files",
        icon: FolderOpen,
        disabled: deleted,
        onSelect: () => {
          const parents: string[] = [root];
          const parts = path.split("/");
          if (!folder) parts.pop();
          let current = root.replace(/\/$/, "");
          for (const part of parts) {
            current += `/${part}`;
            parents.push(current);
          }
          useExplorerStore
            .getState()
            .updateFolders(
              explorerTreeKey(machine, "files", root, workdir),
              (previous) => new Set([...(previous ?? []), ...parents]),
            );
          useFileStore.getState().setRevealPath(full);
          useUiStore.getState().showSidebarView("files");
          if (isMobileViewport()) useUiStore.getState().setMobileTab("files");
        },
      },
      {
        label: "Copy path",
        icon: ClipboardCopy,
        separated: true,
        onSelect: () => {
          void copy(path);
        },
      },
      {
        label: "Copy absolute path",
        icon: ClipboardCopy,
        onSelect: () => {
          void copy(full);
        },
      },
    );
    const conflict = entries.some(
      (entry) =>
        entry.index === "U" ||
        entry.worktree === "U" ||
        ["AA", "DD"].includes(entry.index + entry.worktree),
    );
    if (writable && supported) {
      actions.push({
        label: scope === "staged" ? "Unstage changes" : "Stage changes",
        icon: scope === "staged" ? Minus : Plus,
        separated: true,
        disabled: !available || conflict,
        onSelect: () => {
          if (target) void run(scope === "staged" ? "unstage" : "stage", target);
        },
      });
      if (scope !== "staged")
        actions.push({
          label:
            scope === "untracked" ? (folder ? "Delete files" : "Delete file") : "Discard changes",
          icon: scope === "untracked" ? Trash2 : Undo2,
          destructive: true,
          separated: true,
          disabled: !available || conflict,
          onSelect: () => {
            if (target) {
              setError(null);
              setCompleted(0);
              setConfirmation(target);
            }
          },
        });
    }
    return actions;
  };
  return {
    menu,
    confirmation,
    pending,
    completed,
    error,
    confirm: () => {
      if (confirmation) void run("discard", confirmation);
    },
    close: () => setConfirmation(null),
  };
}
