import { create } from "zustand";
import type { AuthSuccessMessage, ConnectionState } from "@/protocol";

/**
 * What the relay said this credential may do, from `auth:success`.
 *
 * `null` means "unrestricted" — either a full grant, or a relay old enough not
 * to send the field at all. Both are in fact unrestricted, so the two collapse
 * to one case rather than needing an "unknown" state.
 *
 * Advisory only. Every restriction here is enforced server-side on every
 * message; this exists so the UI can be honest rather than offering controls
 * that can only ever answer with an error.
 */
export type Capabilities = NonNullable<AuthSuccessMessage["capabilities"]>;

/**
 * Message types the connected relay said it understands (`auth:success`).
 *
 * Empty for a relay too old to send the field — which is the honest reading,
 * since such a relay answers `INVALID_MESSAGE` for every one of them.
 */
export type Features = ReadonlySet<string>;

const NO_FEATURES: Features = new Set<string>();

interface ConnectionStore {
  status: ConnectionState;
  latency: number | null;
  reconnectCount: number;
  serverVersion: string | null;
  hostname: string | null;
  defaultPath: string | null;
  capabilities: Capabilities | null;
  features: Features;
  setStatus: (status: ConnectionState) => void;
  setLatency: (latency: number) => void;
  incrementReconnect: () => void;
  resetReconnect: () => void;
  setServerInfo: (
    version: string,
    hostname: string,
    defaultPath?: string,
  ) => void;
  setCapabilities: (capabilities: Capabilities | null) => void;
  setFeatures: (features: string[] | undefined) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: "disconnected" as ConnectionState,
  latency: null,
  reconnectCount: 0,
  serverVersion: null,
  hostname: null,
  defaultPath: null,
  capabilities: null,
  features: NO_FEATURES,
  setStatus: (status) => set({ status }),
  setLatency: (latency) => set({ latency }),
  incrementReconnect: () =>
    set((s) => ({ reconnectCount: s.reconnectCount + 1 })),
  resetReconnect: () => set({ reconnectCount: 0 }),
  setServerInfo: (serverVersion, hostname, defaultPath) =>
    set({ serverVersion, hostname, defaultPath: defaultPath ?? null }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setFeatures: (features) =>
    set({ features: features ? new Set(features) : NO_FEATURES }),
}));

/** True when the connection may not type into the terminal. */
export function isReadOnly(capabilities: Capabilities | null): boolean {
  return capabilities?.readOnly === true;
}

/** True when file operations would be refused, so the UI should not offer them. */
export function filesDisabled(capabilities: Capabilities | null): boolean {
  return capabilities?.files === "none";
}

/** True when the relay understands the relative window/pane step messages. */
export function supportsStep(features: Features): boolean {
  return features.has("window:step") && features.has("pane:step");
}
