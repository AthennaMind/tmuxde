import { relayUrl } from "@/env";

const RELAY_PATH = "/_relay";

/** WebSocket URL of the server: the configured one, else this origin. */
export function resolveRelayWsUrl(): string {
  if (relayUrl) return relayUrl;
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${RELAY_PATH}`;
}

/** HTTP origin for `/file` requests. Empty outside a browser. */
export function resolveRelayHttpBase(): string {
  if (relayUrl) {
    const url = new URL(relayUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.origin;
  }
  if (typeof window === "undefined") return "";
  return window.location.origin;
}
