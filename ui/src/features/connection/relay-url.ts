import { machineId } from "./machine-context";
import { relayUrl } from "@/app/env";

const RELAY_PATH = "/_relay";

/** WebSocket URL of the server: the configured one, else this origin. */
export function resolveRelayWsUrl(id = machineId()): string {
  if (relayUrl) return withMachine(relayUrl, id);
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return withMachine(`${proto}//${window.location.host}${RELAY_PATH}`, id);
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

function withMachine(value: string, id: string): string {
  if (id === "local") return value;
  const url = new URL(value);
  url.searchParams.set("machine", id);
  return url.toString();
}
