import { z } from "zod";

/**
 * The pairing protocol's version, on the wire.
 *
 * Until 0.7.0 there was none. Nothing in `packages/protocol` carried a version
 * except the at-rest format in `grants.ts`, so the broker
 * could not identify, warn, or refuse a client by version. That is the same
 * gap as having no kill switch: a release that turned out to be dangerous
 * would have stayed in the field, because there was no channel through which
 * to say so and no way to stop it pairing.
 *
 * ## Why it exists now
 *
 * 0.7.0 breaks the wire in two ways that a client cannot detect for itself. The
 * pairing code went from a two-digit slot to three, so a 0.6.x code routes
 * somewhere real and derives a different key — which reads to the user as a
 * wrong code, repeatedly, for as long as they retry. And sealed frames moved to
 * a per-connection subkey, so a 0.6.x peer's frames simply fail to open. Both
 * failures are silent and both look like the *other* side being broken. A floor
 * turns them into one sentence: update tmuxde.
 *
 * ## What the numbers mean
 *
 * `PROTOCOL_VERSION` is what this build speaks. `MIN_PROTOCOL_VERSION` is the
 * lowest a broker built from this source accepts by default. They are equal at
 * 2 because 0.7.0 is a clean break: version 1 is every client that sent no `v`
 * at all, and none of them can complete a pairing against this broker.
 *
 * A self-hoster must be able to change or disable this — see the broker's
 * `minProtocolVersion` config, where zero means "refuse nothing". A floor is a
 * control over other people's software, and the people running a broker for
 * themselves should hold it rather than inherit ours.
 */
export const PROTOCOL_VERSION = 2;

/** The oldest protocol a broker accepts unless its operator says otherwise. */
export const MIN_PROTOCOL_VERSION = 2;

/**
 * A version on the wire.
 *
 * Coerced, because it arrives as a query-string on sockets and as JSON on
 * bodies, and a client that sends `"2"` means 2. Bounded above so a bogus
 * enormous number cannot be waved through by a `>=` comparison in some future
 * caller that forgot to bound it.
 */
export const ProtocolVersionSchema = z.coerce.number().int().min(1).max(1_000);

/**
 * The `v` a socket URL declares, or null.
 *
 * Null means "said nothing", which the broker treats as version 1 — the
 * versionless protocol every client before 0.7.0 spoke. Deliberately not a
 * throw: a malformed `v` and an absent one get the same answer, because both
 * mean the caller has not proved it speaks the current protocol and both
 * deserve the same 426.
 */
export function protocolVersionFromUrl(url: string): number | null {
  let raw: string | null;
  try {
    raw = new URL(url, "http://protocol.invalid").searchParams.get("v");
  } catch {
    return null;
  }
  if (raw === null) return null;
  const parsed = ProtocolVersionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Whether a declared version (null = versionless) clears a floor. */
export function meetsProtocolFloor(
  declared: number | null,
  floor: number = MIN_PROTOCOL_VERSION,
): boolean {
  if (floor <= 0) return true;
  return declared !== null && declared >= floor;
}
