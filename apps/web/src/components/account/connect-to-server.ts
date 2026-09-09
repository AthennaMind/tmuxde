/**
 * Open a registered machine from the dashboard.
 *
 * The interesting part is what this does *not* do: it never asks the broker for
 * permission, and the broker never learns which browsers can reach which
 * machines. Everything needed is already on this device from the first pairing
 * — the session keys and the sealed descriptor, both in IndexedDB — so
 * switching machines is a local lookup plus a mirror write, after which the
 * terminal route behaves exactly as it does after a fresh pair.
 *
 * That is also why a machine this browser has never paired with cannot be
 * opened here. The account knows the machine exists; only the device holds the
 * keys. Saying so plainly beats a button that spins and then fails.
 */
import { deviceIdFor, hexToBytes } from "@repo/crypto";
import { listPairedServerIds } from "@/lib/session-store";

/**
 * The id this browser files a machine's keys under, derived from the machine's
 * public key exactly as the CLI derives its own device id.
 */
export function deviceIdForPublicKey(publicKey: string): string | null {
  try {
    return deviceIdFor(hexToBytes(publicKey));
  } catch {
    return null;
  }
}

/**
 * Which of these machines this browser holds a usable pairing for.
 *
 * Keyed by public key rather than server id so the caller can ask the question
 * straight off the list the API returned, without a second round trip.
 */
export async function pairedServerKeys(
  publicKeys: readonly string[],
): Promise<Set<string>> {
  const stored = new Set(await listPairedServerIds());
  const paired = new Set<string>();
  for (const key of publicKeys) {
    const deviceId = deviceIdForPublicKey(key);
    if (deviceId && stored.has(deviceId)) paired.add(key);
  }
  return paired;
}

/*
 * `connectToServer` used to live here — a "look up the keys, then navigate"
 * helper that only `ServerList` ever called. That list is gone: the session
 * cards do the same thing through `activateDescriptor` directly, because they
 * already know which session to open and this helper did not.
 */
