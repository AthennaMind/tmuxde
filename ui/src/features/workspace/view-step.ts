import { useMachineStore, type TerminalTab } from "@/features/connection/machine-store";
import { useSessionStore } from "@/features/session/session-store";
import { getTerminalHandle } from "@/features/terminal/terminal-handle";
import { isMobileViewport } from "@/shared/mobile-query";
import { TERMINAL_TAB, reconcileTabOrder, useMainTabsStore } from "./main-tabs-store";
import { activateView, openMachineSession } from "./workspace-target";

/**
 * Previous and next view, in the order the tab strip shows: terminal
 * sessions and tabs, after any drag. Both ends wrap.
 */

/** Strip id of a terminal session. */
export function terminalViewId(terminal: TerminalTab): string {
  return JSON.stringify(["terminal", terminal.machineId, terminal.sessionName]);
}

export interface ViewState {
  order: readonly string[];
  terminals: readonly TerminalTab[];
  tabIds: readonly string[];
  /** `TERMINAL_TAB` or a tab id. */
  active: string;
  activeMachine: string;
  activeSession: string | null;
}

/** Strip order and the view showing now. `current` is null when the strip holds none of it. */
export function viewOrder(state: ViewState): { order: string[]; current: string | null } {
  const order = reconcileTabOrder(
    [...state.order],
    [...state.terminals.map(terminalViewId), ...state.tabIds],
  );
  let current: string | null = state.active;
  if (state.active === TERMINAL_TAB) {
    current =
      state.activeSession === null
        ? null
        : terminalViewId({ machineId: state.activeMachine, sessionName: state.activeSession });
  }
  return { order, current: current !== null && order.includes(current) ? current : null };
}

/**
 * The view `delta` steps from `current`, wrapping at both ends. Null when
 * there is nowhere else to go. Without a current view, next is the first
 * and previous the last.
 */
export function neighbourView(
  order: readonly string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (current === null) return (delta === 1 ? order[0] : order.at(-1)) ?? null;
  if (order.length < 2) return null;
  const index = order.indexOf(current);
  return order[(index + delta + order.length) % order.length] ?? null;
}

function currentState(): ViewState {
  const tabs = useMainTabsStore.getState();
  const machines = useMachineStore.getState();
  return {
    order: tabs.order,
    terminals: machines.terminals,
    tabIds: tabs.tabs.map((tab) => tab.id),
    active: tabs.active,
    activeMachine: machines.activeMachine,
    activeSession: useSessionStore.getState().activeSessionId,
  };
}

function target(delta: 1 | -1): { id: string; terminal?: TerminalTab } | null {
  const state = currentState();
  const { order, current } = viewOrder(state);
  const id = neighbourView(order, current, delta);
  if (id === null) return null;
  const terminal = state.terminals.find((entry) => terminalViewId(entry) === id);
  return terminal ? { id, terminal } : { id };
}

export function canStepView(): boolean {
  return target(1) !== null;
}

/**
 * Show the neighbour view, as a click on its tab does. Focus follows, so
 * keys never land in a terminal that went out of sight: the terminal for a
 * session, the tab in the strip for anything else.
 */
export function stepView(delta: 1 | -1): void {
  const next = target(delta);
  if (!next) return;
  if (next.terminal) openMachineSession(next.terminal.machineId, next.terminal.sessionName);
  else activateView(next.id);
  // A phone would open its keyboard for the terminal.
  if (isMobileViewport()) return;
  requestAnimationFrame(() => {
    if (next.terminal) {
      getTerminalHandle()?.focus();
      return;
    }
    const handle = document.querySelector<HTMLElement>(
      `[data-view-id="${CSS.escape(next.id)}"] [data-view-handle]`,
    );
    if (handle) handle.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
}
