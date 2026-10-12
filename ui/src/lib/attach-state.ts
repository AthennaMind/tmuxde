/**
 * Attach state machine for the terminal view.
 *
 * The previous implementation spread this across three mutable refs
 * (`attachedSessionRef` / `sessionReadyRef` / `pendingSessionRef`) updated from
 * two different places, which produced several unrecoverable wedges:
 *
 *  - switching A -> B -> A before B's ack skipped the re-attach entirely, after
 *    the cleanup had already sent `session:detach`;
 *  - an effect cleanup interleaving with an in-flight attach nulled the pending
 *    name, so the matching ack was ignored and all output was dropped forever;
 *  - a reconnect could send two attaches, respawning the PTY twice.
 *
 * Modelling it as one value with an explicit attach epoch makes those states
 * unrepresentable. This module is deliberately pure and dependency-free so it
 * can be unit-tested in a plain node environment.
 */

export type AttachState =
  | { phase: "idle" }
  | { phase: "attaching"; name: string; attachId: string }
  | { phase: "attached"; name: string; attachId: string };

export type AttachEvent =
  | { type: "requestAttach"; name: string; attachId: string }
  | { type: "serverAttached"; name: string; attachId?: string }
  | { type: "detach" }
  | { type: "connectionLost" };

export const IDLE: AttachState = { phase: "idle" };

let attachCounter = 0;

/** Monotonic attach epoch. A counter (not a random id) keeps tests readable. */
export function nextAttachId(): string {
  attachCounter += 1;
  return `a${attachCounter}`;
}

/** Test seam — resets the epoch counter. */
export function resetAttachIds(): void {
  attachCounter = 0;
}

export function reduceAttach(
  state: AttachState,
  event: AttachEvent,
): AttachState {
  switch (event.type) {
    case "requestAttach":
      // Only a settled attach to the *same* session is a no-op. An attach in
      // flight to a different name must be superseded, otherwise switching back
      // before the first ack lands leaves the client detached with no pending
      // request.
      if (state.phase === "attached" && state.name === event.name) {
        return state;
      }
      return {
        phase: "attaching",
        name: event.name,
        attachId: event.attachId,
      };

    case "serverAttached": {
      if (state.phase !== "attaching") return state;
      // Accept only the ack for the attach we are currently waiting on. Relays
      // that predate `attachId` don't echo one; fall back to matching on name
      // so this stays backwards compatible.
      const matches =
        event.attachId !== undefined
          ? event.attachId === state.attachId
          : event.name === state.name;
      if (!matches) return state;
      return { phase: "attached", name: state.name, attachId: state.attachId };
    }

    case "detach":
      return IDLE;

    case "connectionLost":
      // Keep the desired session but drop back to "attaching" so the single
      // status-driven attach effect re-issues exactly one attach on reconnect.
      if (state.phase === "idle") return state;
      return { phase: "attaching", name: state.name, attachId: state.attachId };
  }
}

/** Server output may only be written once the ack for this attach has landed. */
export function shouldWriteOutput(state: AttachState): boolean {
  return state.phase === "attached";
}

/** True when an attach for `desired` still needs to be sent. */
export function needsAttach(state: AttachState, desired: string): boolean {
  return !(state.phase === "attached" && state.name === desired);
}

/** The session this state refers to, if any. */
export function attachedName(state: AttachState): string | null {
  return state.phase === "idle" ? null : state.name;
}
