import { env } from "@/env";

/** Only contact this origin or the relay explicitly selected by this build. */
export function localCandidates(candidates: readonly string[]): string[] {
  const origins = new Set<string>();
  if (typeof window !== "undefined" && window.location?.origin) {
    origins.add(window.location.origin);
  }
  if (env.NEXT_PUBLIC_RELAY_URL) {
    const relay = new URL(env.NEXT_PUBLIC_RELAY_URL);
    relay.protocol = relay.protocol === "wss:" ? "https:" : "http:";
    origins.add(relay.origin);
  }
  return candidates.filter((candidate) => {
    try {
      const url = new URL(candidate);
      return (
        origins.has(url.origin) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
      );
    } catch {
      return false;
    }
  });
}
