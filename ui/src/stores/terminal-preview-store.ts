import { create } from "zustand";
import type { PreviewFrame, PreviewTarget, TerminalPreviewFrameMessage } from "@/protocol";
import { sessionLocks } from "@/lib/lock-store";
import { get as getClient, onDisconnectAll } from "@/lib/relay-registry";
import { subscribeKeys } from "@/lib/unlocked";
import { useMachineStore } from "./machine-store";

export const previewKey = (machine: string, pane: string) => JSON.stringify([machine, pane]);
interface PreviewState {
  frames: Record<string, PreviewFrame>;
  watching: Record<string, boolean>;
}
export const useTerminalPreviewStore = create<PreviewState>(() => ({ frames: {}, watching: {} }));
const owners = new Map<
  string,
  { machine: string; targets: PreviewTarget[]; autonomous: boolean }
>();
const requests = new Map<string, { id: string; signature: string; panes: Set<string> }>();
let open = false;
let suspended = false;
let stopLifecycle: (() => void) | undefined;
let hidden = false;
let pending: ReturnType<typeof setTimeout> | undefined;

export function receiveTerminalPreview(
  machine: string,
  message: TerminalPreviewFrameMessage,
): void {
  const request = requests.get(machine);
  if (suspended || hidden || !request || request.id !== message.requestId) return;
  useTerminalPreviewStore.setState((state) => {
    const frames = { ...state.frames };
    for (const frame of message.frames) {
      if (request.panes.has(frame.paneId)) frames[previewKey(machine, frame.paneId)] = frame;
    }
    return { frames };
  });
}

/** Register only visible cards. Owners survive unrelated inventory updates. */
export function watchPreview(
  owner: string,
  machine: string,
  targets: PreviewTarget[],
  autonomous = false,
): () => void {
  suspended = false;
  owners.set(owner, { machine, targets, autonomous });
  startLifecycle();
  schedule();
  return () => {
    owners.delete(owner);
    syncPreviews();
    if (!owners.size) {
      stopLifecycle?.();
      stopLifecycle = undefined;
    }
  };
}
/** One live subscription lifecycle for Overview and hover owners. */
function startLifecycle(): void {
  if (stopLifecycle || typeof document === "undefined") return;
  hidden = document.hidden;
  const visibility = () => {
    hidden = document.hidden;
    syncPreviews();
  };
  const timer = setInterval(() => syncPreviews(true), 20_000);
  document.addEventListener("visibilitychange", visibility);
  stopLifecycle = () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", visibility);
  };
}

function schedule(): void {
  clearTimeout(pending);
  pending = setTimeout(() => syncPreviews(), 40);
}
function stop(machine: string): void {
  if (!requests.has(machine)) return;
  requests.delete(machine);
  const client = getClient(`inventory:${machine}`);
  if (client?.status === "connected")
    client.send({
      type: "terminal:preview",
      requestId: crypto.randomUUID(),
      targets: [],
      excludeSessions: [],
      once: false,
    });
}

/** Refresh also renews each live subscription's 35 second lease. */
export function syncPreviews(renew = false): void {
  clearTimeout(pending);
  const wanted = new Map<string, PreviewTarget[]>();
  // Give an explicitly opened hover priority over the Overview card limit.
  const ordered = [...owners.values()].sort((a, b) => Number(b.autonomous) - Number(a.autonomous));
  if (!suspended && !hidden)
    for (const owner of ordered) {
      if (!open && !owner.autonomous) continue;
      const list = wanted.get(owner.machine) ?? [];
      for (const target of owner.targets) {
        if (!list.some((entry) => entry.paneId === target.paneId)) list.push(target);
      }
      wanted.set(owner.machine, list);
    }
  for (const machine of requests.keys()) if (!wanted.has(machine)) stop(machine);
  const watching: Record<string, boolean> = {};
  const keep = new Set<string>();
  for (const [machine, targets] of wanted) {
    const excluded = Object.keys(sessionLocks(machine)).sort();
    const client = getClient(`inventory:${machine}`);
    const supported = useMachineStore
      .getState()
      .machines.find((m) => m.id === machine)
      ?.features.includes("terminal:preview");
    if (!supported || client?.status !== "connected" || excluded.length > 1024) {
      stop(machine);
      continue;
    }
    for (const target of targets) watching[previewKey(machine, target.paneId)] = false;
    const allowed = targets.filter((target) => !excluded.includes(target.session)).slice(0, 32);
    for (const target of allowed) {
      const key = previewKey(machine, target.paneId);
      watching[key] = true;
      keep.add(key);
    }
    const signature = JSON.stringify([allowed, excluded]);
    const previous = requests.get(machine);
    if (previous?.signature === signature && !renew) continue;
    if (!allowed.length) {
      stop(machine);
      continue;
    }
    const id = crypto.randomUUID();
    requests.set(machine, {
      id,
      signature,
      panes: new Set(allowed.map((target) => target.paneId)),
    });
    client.send({
      type: "terminal:preview",
      requestId: id,
      targets: allowed,
      excludeSessions: excluded,
      once: false,
    });
  }
  // Screens stay only for visible cards. No terminal content is persisted.
  useTerminalPreviewStore.setState((state) => ({
    watching,
    frames: Object.fromEntries(Object.entries(state.frames).filter(([key]) => keep.has(key))),
  }));
}

export function configurePreviews(options: { open: boolean; hidden: boolean }): void {
  open = options.open;
  hidden = options.hidden;
  if (open) {
    suspended = false;
    if (owners.size) startLifecycle();
  }
  syncPreviews();
}
export function previewConnectionChanged(machine: string): void {
  requests.delete(machine);
  useTerminalPreviewStore.setState((state) => ({
    frames: Object.fromEntries(
      Object.entries(state.frames).filter(([key]) => JSON.parse(key)[0] !== machine),
    ),
  }));
  schedule();
}
export function resetPreviews(): void {
  open = false;
  suspended = true;
  stopLifecycle?.();
  stopLifecycle = undefined;
  clearTimeout(pending);
  for (const machine of requests.keys()) stop(machine);
  useTerminalPreviewStore.setState({ frames: {}, watching: {} });
}
subscribeKeys((machine) => {
  // A newly locked session can share panes with another session. Discard all
  // frames on this machine before requesting the server's exclusion check.
  stop(machine);
  previewConnectionChanged(machine);
});
onDisconnectAll(resetPreviews);
