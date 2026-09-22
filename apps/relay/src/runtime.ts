// Single entry-point used by apps/cli to embed the relay alongside Next.js.
// The CLI bundle inlines this and the workspace packages it transitively
// depends on (@repo/logger, @repo/protocol). External npm deps stay external.

export { createWsServerNoBind, attachUpgrade } from "./ws-server.js";
export { wireConnections } from "./wire-connections.js";
export {
  handleRelayRequest,
  PAIR_LOCAL_PATH,
  PAIR_SESSION_PATH,
} from "./server.js";
export {
  armLocalPairing,
  onLocalPairingSpent,
  setLocalPairingGate,
  onSessionTokenUsed,
  registerSessionToken,
  revokeSessionToken,
  type LocalPairingOutcome,
  type LocalPairingRequest,
} from "./pairing-local.js";
export {
  connectionSummary,
  connectionDetails,
  disconnectConnection,
  onConnectionsChanged,
  type ConnectedDevice,
  type ConnectionDetail,
  type ConnectionScope,
} from "./connection-manager.js";

/**
 * In-app device approval, for `decideAccess`.
 *
 * Exported as a plain function rather than reached over loopback HTTP the way
 * `mtmux approve` is, because unlike `mtmux approve` the caller is *this
 * process*: the CLI imports this runtime and holds the relay's memory
 * directly. Going out to a socket and back would add a failure mode to a
 * security prompt for no gain.
 */
export { askDeviceApproval } from "./device-approval.js";

/**
 * Recording, for `mtmux record`'s loopback control endpoint.
 *
 * Namespaced rather than re-exported one function at a time: `list` and
 * `remove` come from the index and `start`/`stop` from the recorder, and
 * flattening those into the runtime's top level would put four very
 * generic names beside `wireConnections`.
 */
export * as recorder from "./recorder.js";
export * as recordings from "./recordings-index.js";
