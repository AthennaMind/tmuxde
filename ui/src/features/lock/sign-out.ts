import { clearMachineStorage } from "@/features/connection/machine-context";
import { disconnectAll } from "@/features/connection/relay-registry";
import { useCommandStore } from "@/features/terminal/command-store";
import { useConnectionStore } from "@/features/connection/connection-store";
import { useFileStore } from "@/features/files/file-store";
import { TERMINAL_TAB, useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { useSessionStore } from "@/features/session/session-store";
import { forgetSealedLocalToken } from "./lock-store";
import { LAST_SESSION_KEY, TOKEN_KEY, clearStored } from "@/features/connection/storage-keys";
import { setLocalToken } from "./unlocked";

/**
 * Disconnect this device from the server.
 *
 * Drops the socket and every home of the token: localStorage, the in-memory
 * copy that a lock keeps, and the sealed copy in the lock store. Clearing
 * localStorage alone does nothing on a device with a lock.
 *
 * It does not touch the device lock or anything on the machine. The tmux
 * sessions keep running. "Erase everything on this device" is a louder action
 * in `LockSettings`. Hence the button says Disconnect, not Log out.
 */
export async function disconnectDevice(): Promise<void> {
  // Drop the socket before anything else: an authenticated connection outliving
  // the credentials that opened it is a live capability with no owner.
  try {
    disconnectAll();
  } catch {
    // Already gone.
  }

  useSessionStore.getState().setSessions([]);
  useSessionStore.getState().setActiveSession(null);
  useConnectionStore.getState().setStatus("disconnected");
  useConnectionStore.getState().resetReconnect();
  useCommandStore.getState().clearHistory();
  useFileStore.getState().setEntries([]);
  useFileStore.getState().setSelectedFile(null);
  useFileStore.getState().setFileContent(null);
  useMainTabsStore.setState({ tabs: [], active: TERMINAL_TAB, order: [] });

  // Both homes of the self-hosted token. `clearStored` alone leaves an enrolled
  // device still holding it in memory, which is exactly the case that made the
  // old sign-out a no-op.
  clearStored(TOKEN_KEY);
  clearStored(LAST_SESSION_KEY);
  clearMachineStorage();
  setLocalToken(null);
  // The third home, on a device with a lock. An unlock restores it.
  await forgetSealedLocalToken();

  /**
   * A full navigation, not `router.push`.
   *
   * Every store this just emptied is module state, and several of them —
   * `unlocked.ts`'s key cache and the relay client singleton, are not
   * Zustand and have no reset. A client-side
   * transition would carry all of it into the next page. Reloading the document
   * is the one thing that reliably leaves nothing behind, and the user is on
   * their way to a login screen anyway, so the cost is a page load they were
   * getting regardless.
   */
  if (typeof window !== "undefined") window.location.assign("/login");
}
