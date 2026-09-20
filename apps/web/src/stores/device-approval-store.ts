import { create } from "zustand";
import type { DeviceApprovalRequestMessage } from "@repo/protocol";

/**
 * The one question this app asks the user, rather than answers for them.
 *
 * Kept in its own store rather than folded into `alert-store` because an alert
 * is something you dismiss and a question is something you answer, and the two
 * must never be able to look alike. An alert that auto-dismisses after six
 * seconds is correct for "a device paired"; it would be a security hole for
 * "should this device be let in?" — a request that timed out because the banner
 * faded is a request the user was never really asked.
 *
 * At most one request is live at a time, which is the relay's rule too
 * (`device-approval.ts`), so this is a single slot and not a queue.
 */

interface DeviceApprovalStore {
  request: DeviceApprovalRequestMessage | null;
  /**
   * An answer has been sent and we are waiting for the relay to confirm.
   *
   * Tracked so the buttons can disable themselves. Double-tapping "Approve" on
   * a laggy phone link would otherwise send two answers, and the second one
   * comes back as `APPROVAL_NOT_PENDING` — an error toast for doing exactly
   * what the UI invited.
   */
  answering: boolean;
  open: (request: DeviceApprovalRequestMessage) => void;
  markAnswering: () => void;
  /**
   * The question is closed — by an answer here, by one elsewhere, or by the
   * clock. What happened is announced through `alert-store`, which is the
   * right shape for it: news, not a decision.
   */
  close: () => void;
  /** Connection dropped — the question can no longer be answered from here. */
  abandon: () => void;
}

/**
 * The test seam, and why it is compiled out of anything shipped.
 *
 * A device approval request cannot be manufactured from a spec: it originates
 * in a real CPace exchange between a browser and the broker, and the lab
 * container has no broker and no second browser. Without a seam the one dialog
 * in the product that a stray keypress must never dismiss would be the one
 * surface never tested at a phone viewport — which is precisely the mistake
 * `playwright.config.ts` already records paying for once.
 *
 * `process.env.NODE_ENV` is inlined by the bundler and the dead branch removed,
 * so a production bundle carries neither the property nor the assignment. The
 * lab runs `next dev`, where it is present. It exposes only the store: the
 * answer still travels over the real socket and is still decided by the relay.
 */
declare global {
  interface Window {
    __mtmuxDeviceApproval?: typeof useDeviceApprovalStore;
  }
}

export const useDeviceApprovalStore = create<DeviceApprovalStore>((set) => ({
  request: null,
  answering: false,
  open: (request) => set({ request, answering: false }),
  markAnswering: () => set({ answering: true }),
  close: () => set({ request: null, answering: false }),
  // Deliberately identical to `close`, and named differently anyway: nothing
  // was decided here, so no notice is pushed. Saying "denied" because our
  // socket dropped would be telling the user an outcome the machine may still
  // be asking somebody else about.
  abandon: () => set({ request: null, answering: false }),
}));

if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  window.__mtmuxDeviceApproval = useDeviceApprovalStore;
}
