import { useEffect } from "react";
import { useMachineStore } from "@/features/connection/machine-store";
import { isMachineTab, useMainTabsStore } from "./main-tabs-store";
import { activateView } from "./workspace-target";

/**
 * Ask for the machine of the active tab when it is not the active one.
 *
 * A tab restored on load, or the neighbour a closed tab hands over to, can
 * belong to another machine. The layout calls this right before it opens the
 * terminal socket. Effects of one component run in order, so a switch asked
 * for here is in the store before the socket effect looks, and no socket
 * opens to the machine being left.
 */
export function useActiveTabMachine(): void {
  const activeTab = useMainTabsStore((s) => s.active);
  const activeMachine = useMachineStore((s) => s.activeMachine);
  useEffect(() => {
    const tab = useMainTabsStore.getState().tabs.find((item) => item.id === activeTab);
    if (tab && isMachineTab(tab) && (tab.machineId ?? "local") !== activeMachine) {
      activateView(tab.id);
    }
  }, [activeTab, activeMachine]);
}
