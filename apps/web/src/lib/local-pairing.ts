import { resolveRelayHttpBase } from "@/lib/relay-url";
import { deviceLabel } from "@/lib/device-label";

export const PAIR_LOCAL_PATH = "/_pair/local";

export type LocalPairingResult = { token: string; expiresAt: number };

/**
 * Redeem what `mtmux start` printed — the QR's nonce, or the six digits under
 * it — for a scoped session token.
 *
 * The nonce arrives in the URL *fragment* (`/login#n=…`), so it is never sent
 * to the server as part of the navigation and never lands in an access log.
 * Both halves are posted in a request body rather than a query string for the
 * same reason.
 *
 * Only single-port CLI mode ever arms an offer; in the split deployment the
 * relay has none outstanding and this always fails closed.
 *
 * ## It waits, and that is the feature
 *
 * The machine asks a human before it answers, so this request stays open for
 * as long as that question is on screen — up to about two minutes. There is
 * deliberately no timeout here: aborting would leave the person at the machine
 * approving a device that had already given up, which is the worst of both
 * ends. Callers show "waiting for approval" while it is in flight.
 */
export async function redeemLocalPairing(
  credential: { nonce?: string; code?: string },
  signal?: AbortSignal,
): Promise<LocalPairingResult> {
  const res = await fetch(`${resolveRelayHttpBase()}${PAIR_LOCAL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Self-reported, and the machine treats it as such. It exists so the
    // question on the terminal names something ("iPhone · Safari") instead of
    // asking about an anonymous request nobody can identify.
    body: JSON.stringify({ ...credential, label: deviceLabel() }),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    // 403 and 401 are different facts and get different sentences. Telling
    // somebody whose code was right and was declined that it is "invalid"
    // sends them looking for a typo that does not exist.
    if (res.status === 403) {
      throw new Error(
        "The machine refused this device. Approve it in the terminal, then try a fresh code.",
      );
    }
    throw new Error(
      res.status === 401
        ? "That code has expired or was already used. Check your terminal for a fresh one."
        : `Pairing failed (${res.status})`,
    );
  }

  const body = (await res.json()) as Partial<LocalPairingResult>;
  if (typeof body.token !== "string" || !body.token) {
    throw new Error("Pairing failed: malformed response");
  }
  return { token: body.token, expiresAt: body.expiresAt ?? 0 };
}

/** The QR half, by name, for the `#n=` handoff. */
export function redeemLocalPairingNonce(
  nonce: string,
  signal?: AbortSignal,
): Promise<LocalPairingResult> {
  return redeemLocalPairing({ nonce }, signal);
}

/** The typed half, for someone who cannot point a camera at the terminal. */
export function redeemLocalPairingCode(
  code: string,
  signal?: AbortSignal,
): Promise<LocalPairingResult> {
  return redeemLocalPairing({ code }, signal);
}
