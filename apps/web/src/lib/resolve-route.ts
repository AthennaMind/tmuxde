import type { SessionKeys } from "@repo/crypto";
import { localCandidates } from "./local-candidates";
import { raceCandidates } from "./candidate-race";
import type { TransportFactory } from "./transport";
import {
  loadDescriptor,
  loadSessionKeys,
  saveDescriptor,
  serverIdFor,
  type PairedSession,
} from "./session-store";

/** Resolve saved credentials only against permitted local relay origins. */
export type ResolvedRoute = {
  /** Null means no permitted relay accepted this saved credential. */
  preferredCandidate: string | null;
  /** Retained for transport consumers. Local routes use plain sockets. */
  transport?: TransportFactory;
};

export async function resolveRoute(
  session: PairedSession,
  keys: SessionKeys,
): Promise<ResolvedRoute> {
  const { winner } = await raceCandidates(
    localCandidates(session.descriptor.candidates),
    keys.directToken,
  );

  persistPreferred(session, winner);

  if (winner) return { preferredCandidate: winner };

  return { preferredCandidate: null };
}

/**
 * Re-decide the route for whatever session this tab is driving.
 *
 * The reconnect loop has no idea which machine it is talking to — it holds a
 * transport and a token — so this reads the active descriptor itself. Returns
 * null on the self-hosted path, where there is no descriptor and nothing to
 * re-decide, which is also what makes this safe to call unconditionally.
 */
export async function reresolveActiveRoute(): Promise<ResolvedRoute | null> {
  const session = loadDescriptor();
  if (!session) return null;
  const keys = await loadSessionKeys(serverIdFor(session.descriptor));
  if (!keys) return null;
  return resolveRoute(session, keys);
}

/**
 * Write the decision back, so the next cold start tries the winner first.
 *
 * Re-read rather than reusing the caller's `session`: resolving is async and
 * the descriptor may have been re-activated for a different machine while the
 * race was in flight. Writing a stale copy would repoint the active session at
 * whichever machine was resolved last — the same class of bug
 * `loadDescriptorFor` exists to avoid in the census.
 */
function persistPreferred(session: PairedSession, winner: string | null): void {
  const current = loadDescriptor();
  if (!current) return;
  if (current.descriptor.tunnelId !== session.descriptor.tunnelId) return;
  if ((current.preferredCandidate ?? null) === winner) return;

  const { preferredCandidate: _previous, ...rest } = current;
  saveDescriptor(winner ? { ...rest, preferredCandidate: winner } : rest);
}
