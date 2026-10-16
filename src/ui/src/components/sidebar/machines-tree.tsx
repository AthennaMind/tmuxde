import { LayoutGrid, Search } from "lucide-react";
import { useMachineStore } from "@/stores/machine-store";
import { openWorkspace } from "@/lib/workspace-target";
import { OVERVIEW_TAB, TERMINAL_TAB, useMainTabsStore } from "@/stores/main-tabs-store";
import { SessionTree } from "./session-tree";
import { PanelHeader, PanelIconButton } from "./panel-header";
import { useTerminalSearchStore } from "@/stores/terminal-search-store";

/**
 * Every machine's session tree. `visible` is false while the trees stay
 * mounted under another view, which pauses their clocks and requests.
 */
export function MachinesTree({
  onCreateSession,
  visible = true,
}: {
  onCreateSession: () => void;
  visible?: boolean;
}) {
  const machines = useMachineStore((s) => s.machines);
  const loaded = useMachineStore((s) => s.loaded);
  const error = useMachineStore((s) => s.error);
  const overviewActive = useMainTabsStore((s) => s.active === OVERVIEW_TAB);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Sessions">
        <PanelIconButton label="Search all terminals" icon={Search} onClick={() => useTerminalSearchStore.setState({ open: true })} />
        <PanelIconButton
          label="Overview (Ctrl+O)"
          icon={LayoutGrid}
          pressed={overviewActive}
          onClick={() => {
            const tabs = useMainTabsStore.getState();
            if (overviewActive) tabs.showTerminal();
            else tabs.openOverview();
          }}
        />
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p role="status" className="px-3 py-2 text-sm text-muted-foreground">Server unavailable</p>}
        {!loaded && !error && <p role="status" className="px-3 py-2 text-sm text-muted-foreground">Loading machines</p>}
        {loaded && !machines.length && <p className="px-3 py-2 text-sm text-muted-foreground">No machines registered</p>}
        {machines.map((machine) => (
          <SessionTree
            key={machine.id}
            machine={machine}
            visible={visible}
            onCreateSession={() => {
              if (machine.id === useMachineStore.getState().activeMachine) {
                onCreateSession();
              } else if (openWorkspace({
                machineId: machine.id,
                sessionName: "",
                tabId: TERMINAL_TAB,
                messages: [],
              })) {
                useMachineStore.setState({ createSession: true });
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}
