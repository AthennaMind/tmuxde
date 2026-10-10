import { env } from "@/env";
import { loadDescriptor } from "@/lib/session-store";
import { localCandidates } from "./local-candidates";
import { usableCandidates } from "@/lib/candidate-race";

const RELAY_PATH = "/_relay";

/** Prefer a valid saved local route, then configured relay, then this origin. */
export function resolveRelayWsUrl(): string {
  // An invalid saved route must not send its credential to another machine.
  const paired = pairedRelayUrl();
  if (paired) return paired;
  if (loadDescriptor()) return "";

  if (env.NEXT_PUBLIC_RELAY_URL) return env.NEXT_PUBLIC_RELAY_URL;
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${RELAY_PATH}`;
}

/** Resolve a saved machine only when its candidate is permitted here. */
export function pairedRelayUrl(): string | null {
  const session = loadDescriptor();
  if (!session) return null;

  // Both origin restrictions and browser mixed-content rules apply.
  const [usable] = usableCandidates(
    localCandidates(
      session.preferredCandidate ? [session.preferredCandidate] : [],
    ),
  );
  if (usable) return `${usable.replace(/^http/, "ws")}${RELAY_PATH}`;

  return null;
}

/** True when this tab has an active saved machine descriptor. */
export function isPairedSession(): boolean {
  return loadDescriptor() !== null;
}

/** HTTP base for local file access. Empty means no permitted route. */
export function resolveRelayHttpBase(): string {
  const session = loadDescriptor();
  if (session) {
    const [usable] = usableCandidates(
      localCandidates(
        session.preferredCandidate ? [session.preferredCandidate] : [],
      ),
    );
    return usable ?? "";
  }

  if (env.NEXT_PUBLIC_RELAY_URL) {
    return env.NEXT_PUBLIC_RELAY_URL.replace(/^ws:/, "http:").replace(
      /^wss:/,
      "https:",
    );
  }
  if (typeof window === "undefined") return "";
  return window.location.origin;
}
