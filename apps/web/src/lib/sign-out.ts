import { getRelayClient } from "@/hooks/use-websocket";
import { useCommandStore } from "@/stores/command-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useFileStore } from "@/stores/file-store";
import { TERMINAL_TAB, useMainTabsStore } from "@/stores/main-tabs-store";
import { useSessionStore } from "@/stores/session-store";
import { clearCensusCache } from "./session-census";
import {
  clearDescriptor,
  clearSessionKeys,
  loadDescriptor,
  serverIdFor,
} from "./session-store";
import { LAST_SESSION_KEY, TOKEN_KEY, clearStored } from "./storage-keys";
import { setLocalToken } from "./unlocked";

/**
 * Disconnect this device from the machine it is attached to.
 *
 * ## Why this is not three lines in the settings page
 *
 * The old "Logout" cleared `TOKEN_KEY` and pushed `/login`, which worked for
 * exactly one of the two ways a browser can be attached to a machine:
 *
 *  - **Self-hosted token.** Clearing localStorage really did end the session —
 *    except once a device lock was enrolled, at which point the plaintext copy
 *    is gone and the live one is a module variable in `unlocked.ts`. Clearing
 *    localStorage then removes nothing at all.
 *  - **A hosted pairing.** Nothing about it lives in localStorage. The keys and
 *    the descriptor are in IndexedDB, so the entry page would immediately
 *    `hydrateDescriptor()`, find a perfectly good session, and send the user
 *    straight back to the terminal they just tried to leave. Signing out was a
 *    round trip that changed nothing.
 *
 * So this drops all four: the socket, the in-memory token, the localStorage
 * copy, and the durable pairing for the machine currently in use.
 *
 * ## What this deliberately does not do
 *
 * It ends *this device's* attachment to *this machine*. It does not touch the
 * device lock, other paired machines' keys, or anything on the machine itself —
 * the tmux sessions keep running, which is the product thesis. "Erase
 * everything on this device" is a different, louder action and it lives in
 * `LockSettings`. Hence the button says **Disconnect**, not "Log out": the
 * former is honest about the scope, and the latter invites people to expect the
 * latter action.
 *
 * The census cache goes too. It is keyed by machine and holds session *names* —
 * leaving "deploy-prod, client-acme" on a device someone just disconnected
 * would be the most descriptive leftover of the lot.
 */
export async function disconnectDevice(): Promise<void> {
  // Drop the socket before anything else: an authenticated connection outliving
  // the credentials that opened it is a live capability with no owner.
  try {
    getRelayClient()?.disconnect();
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
  useMainTabsStore.setState({ tabs: [], active: TERMINAL_TAB });

  // Both homes of the self-hosted token. `clearStored` alone leaves an enrolled
  // device still holding it in memory, which is exactly the case that made the
  // old sign-out a no-op.
  clearStored(TOKEN_KEY);
  clearStored(LAST_SESSION_KEY);
  setLocalToken(null);

  // The pairing for the machine this tab is on. Read the descriptor *before*
  // clearing it — `clearDescriptor` needs the mirror to know which durable
  // record to delete, and afterwards there is nothing left to name the keys.
  const session = loadDescriptor();
  if (session) {
    await clearSessionKeys(serverIdFor(session.descriptor));
  }
  clearDescriptor();

  await clearCensusCache();

  /**
   * A full navigation, not `router.push`.
   *
   * Every store this just emptied is module state, and several of them —
   * `unlocked.ts`'s key cache, the relay client singleton, the census's
   * in-flight probes — are not Zustand and have no reset. A client-side
   * transition would carry all of it into the next page. Reloading the document
   * is the one thing that reliably leaves nothing behind, and the user is on
   * their way to a login screen anyway, so the cost is a page load they were
   * getting regardless.
   */
  if (typeof window !== "undefined") window.location.assign("/start");
}
