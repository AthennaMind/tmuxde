/**
 * The last door, and the only one every device has to walk through.
 *
 * Until this existed, approval happened at *pairing* time and nowhere else.
 * That is one question per credential, not one per connection — so a browser
 * that had been approved once could come back whenever it liked, from wherever
 * it liked, and the machine said nothing. Two things made that worse than it
 * sounds:
 *
 *   - The tunnel agent had a gate of its own (`admitStream`), but it only fired
 *     for devices *restored from disk*, and only when the reconnect policy was
 *     set to ask. Everything else went straight through.
 *   - A credential is a file on somebody else's computer. "It paired once" is
 *     a claim about the past; "somebody is holding it now" is the question.
 *
 * So the gate moved here, to the one line every path crosses: a socket that
 * has just authenticated, before it is told a single thing about this machine.
 * Local, LAN and tunnelled connections are the same code path at this point —
 * `wire-connections.ts` has already resolved which of the three it is, and the
 * gate is handed that as `transport` so the question on screen can say it.
 *
 * Installing no gate means admitting, deliberately: the standalone relay in
 * `apps/relay` has no terminal to ask at, and a relay that refused every
 * connection because nobody wired a prompt would be a relay that fails closed
 * into uselessness. The CLI always installs one.
 */

import type { AccessTransport } from "./access-log.js";

export type ConnectionRequest = {
  /**
   * The registered session token this socket authenticated with, when it used
   * one. Null for the machine's own `AUTH_TOKEN` — the self-hosted bearer
   * token, which has no device record behind it.
   */
  tokenId: string | null;
  /**
   * The device this credential was issued to, when the pairing named one.
   *
   * This, not the token, is what the machine's own records are keyed by — so
   * it is what lets the CLI say "this is the phone you approved a minute ago"
   * rather than asking again about a device it has only just let in.
   */
  deviceId: string | null;
  /** What the pairing recorded this device as, if anything. */
  label: string | null;
  /** How the socket reached the relay. Resolved by `access-log.ts`. */
  transport: AccessTransport;
  /** Self-reported, shown and never trusted. */
  userAgent: string | null;
};

export type ConnectionGate = (req: ConnectionRequest) => Promise<boolean>;

let gate: ConnectionGate | null = null;

export function setConnectionGate(next: ConnectionGate | null): void {
  gate = next;
}

/**
 * Ask, if anyone is there to be asked.
 *
 * A gate that throws is not a yes. The only safe reading of "I could not ask"
 * is the one every other approval channel in this product already uses.
 */
export async function admitConnection(
  req: ConnectionRequest,
): Promise<boolean> {
  if (!gate) return true;
  try {
    return await gate(req);
  } catch {
    return false;
  }
}
