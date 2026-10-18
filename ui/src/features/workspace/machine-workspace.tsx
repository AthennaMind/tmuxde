import { Fragment, useEffect } from "react";
import { useNavigate } from "react-router";
import { useMachines } from "@/features/connection/use-machines";
import { useMachineStore } from "@/features/connection/machine-store";
import { useSessionStore } from "@/features/session/session-store";
import { useSessionTreeStore } from "@/features/session/session-tree-store";
import { useConnectionStore } from "@/features/connection/connection-store";
import { usePaneStore } from "@/features/panes/pane-store";
import { useFileStore } from "@/features/files/file-store";
import { useScrollStore } from "@/features/terminal/scroll-store";
import { useMainTabsStore } from "./main-tabs-store";
import { useCommandStore } from "@/features/terminal/command-store";
import { useUiStore } from "./ui-store";
import { openWorkspace } from "./workspace-target";
import { RequireUnlockDialog } from "@/features/lock/require-unlock-dialog";
import { cancelDictation } from "@/features/dictation/dictation";
import { machineStorageKey, setMachineId } from "@/features/connection/machine-context";
import { useTerminalInput } from "@/features/terminal/terminal-input";
import {
  LAST_SESSION_KEY,
  writeStored,
  readSelfHostedToken,
} from "@/features/connection/storage-keys";
import { noteSessionDetached } from "@/features/session/session-target";
import { resetSessionLifecycle } from "@/features/session/session-lifecycle";
import { resetScrollState } from "@/features/terminal/terminal-scroll";
import { registerDisconnect } from "@/features/lock/lock-controller";
import { disconnectAll } from "@/features/connection/relay-registry";

/** Keep workspace chrome mounted while replacing machine-scoped consumers. */
export function MachineWorkspace({ children }: { children: React.ReactNode }) {
  const requested = useMachineStore((s) => s.requested);
  const unlockTarget = useMachineStore((s) => s.unlockTarget);
  const navigate = useNavigate();
  useMachines(readSelfHostedToken() ?? "");

  useEffect(() => {
    registerDisconnect(disconnectAll);
    return () => registerDisconnect(null);
  }, []);

  useEffect(() => {
    if (!requested) return;
    cancelDictation();
    noteSessionDetached();
    resetSessionLifecycle();
    resetScrollState();
    useTerminalInput.getState().reset();
    useConnectionStore.setState(useConnectionStore.getInitialState());
    usePaneStore.getState().clearAll();
    useSessionTreeStore.setState(useSessionTreeStore.getInitialState());
    useSessionStore.setState(useSessionStore.getInitialState());
    useFileStore.setState(useFileStore.getInitialState());
    useScrollStore.getState().clearScrollState();
    useUiStore.setState({
      copyModeOpen: false,
      capturedPaneId: null,
      capturedContent: null,
      paneMenuId: null,
      paneListOpen: false,
      fabOpen: false,
      resizeModeActive: false,
      terminalSearchOpen: false,
      composerDraft: null,
      switchHint: null,
      mobileTab: "terminal",
    });
    // Reset before changing the persistence key, then hydrate the destination.
    // Save the old history first so clearing memory cannot erase its storage.
    const commands = useCommandStore.persist.getOptions().storage;
    const oldKey = useCommandStore.persist.getOptions().name ?? "tmuxde-commands";
    const saved = commands?.getItem(oldKey);
    useCommandStore.setState({ history: [], snippets: [] });
    if (saved && !(saved instanceof Promise)) commands?.setItem(oldKey, saved);
    setMachineId(requested.machineId);
    useCommandStore.persist.setOptions({ name: machineStorageKey("tmuxde-commands") });
    void useCommandStore.persist.rehydrate();
    useSessionStore.getState().setActiveSession(requested.sessionName || null);
    if (requested.sessionName) writeStored(LAST_SESSION_KEY, requested.sessionName);
    useMainTabsStore.getState().activate(requested.tabId);
    useMachineStore.setState({
      activeMachine: requested.machineId,
      requested: null,
      pendingAction: requested.messages.length
        ? { ...requested, expires: Date.now() + 10_000 }
        : null,
    });
    navigate("/", { replace: true });
  }, [requested, navigate]);

  return (
    <>
      {children}
      <RequireUnlockDialog
        open={unlockTarget !== null}
        sessionName={unlockTarget?.sessionName ?? ""}
        onOpenChange={(open) => {
          if (!open) useMachineStore.setState({ unlockTarget: null });
        }}
        onUnlocked={() => {
          useMachineStore.setState({ unlockTarget: null });
          if (unlockTarget) openWorkspace(unlockTarget, true);
        }}
      />
    </>
  );
}

/** Only views that read the active machine need a fresh component lifetime. */
export function MachineContent({ children }: { children: React.ReactNode }) {
  const switching = useMachineStore((s) => s.requested !== null);
  const machine = useMachineStore((s) => s.activeMachine);
  return switching ? null : <Fragment key={machine}>{children}</Fragment>;
}
