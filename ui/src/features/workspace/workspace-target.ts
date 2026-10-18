import type { ClientMessage } from "@/protocol";
import { useMachineStore, type WorkspaceTarget } from "@/features/connection/machine-store";
import { useSessionStore } from "@/features/session/session-store";
import { TERMINAL_TAB, isMachineTab, useMainTabsStore } from "./main-tabs-store";
import { useUiStore } from "./ui-store";
import { machineId } from "@/features/connection/machine-context";
import { runInSession } from "@/features/session/session-target";
import { isSessionLocked } from "@/features/lock/lock-store";
import { useSessionTreeStore } from "@/features/session/session-tree-store";

/** A tab carries its origin. Picking a terminal never rewrites other tabs. */
export function openMachineSession(
  machine: string,
  session: string,
  messages: ClientMessage[] = [],
): boolean {
  return openWorkspace({
    machineId: machine,
    sessionName: session,
    tabId: TERMINAL_TAB,
    messages,
  });
}

export function openWorkspace(target: WorkspaceTarget, unlocked = false): boolean {
  const alreadyAttached =
    target.machineId === machineId() &&
    useSessionTreeStore.getState().attachedSession === target.sessionName;
  if (
    !unlocked &&
    target.sessionName &&
    !alreadyAttached &&
    isSessionLocked(target.machineId, target.sessionName)
  ) {
    useMachineStore.setState({ unlockTarget: target });
    return false;
  }
  if (
    target.messages.length &&
    target.machineId !== machineId() &&
    useMachineStore.getState().inventory[target.machineId]?.status !== "connected"
  ) {
    return false;
  }
  if (target.machineId === machineId()) {
    if (target.sessionName) {
      const attached = runInSession(target.sessionName, target.messages);
      if (!attached) useSessionStore.getState().setActiveSession(target.sessionName);
    }
    useMainTabsStore.getState().activate(target.tabId);
    useUiStore.getState().setMobileTab("terminal");
    return true;
  }
  const event = new Event("tmuxde:before-workspace-change", { cancelable: true });
  if (!window.dispatchEvent(event)) return false;
  useMachineStore.setState({ requested: target });
  return true;
}

export function activateView(id: string): void {
  const tab = useMainTabsStore.getState().tabs.find((item) => item.id === id);
  // Settings and the overview belong to no machine. They open in place.
  if (!tab || !isMachineTab(tab)) {
    useMainTabsStore.getState().activate(id);
    return;
  }
  openWorkspace({
    machineId: tab.machineId ?? "local",
    sessionName: tab.sessionName ?? "",
    tabId: tab.id,
    messages: [],
  });
}
