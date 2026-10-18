/**
 * The passkey factor, via the WebAuthn `prf` extension.
 *
 * Additive on top of the PIN, never a replacement — `crypto.subtle` and
 * WebAuthn are both secure-context only, and `http://192.168.1.5:14100` is not
 * a secure context. `mtmux start` prints exactly such a URL, so a device
 * enrolled on the LAN would have no way in. The PIN is the mandatory base
 * factor for that reason.
 *
 * It is also the only factor with real entropy. The PRF output is 256 bits and
 * never leaves the authenticator; a 6-digit PIN is about 20. Against someone
 * who copies your IndexedDB and takes it home, this is the one that works.
 *
 * **Zero backend state.** Deliberately distinct from the account passkeys used
 * for signing in: nothing here is registered with the broker, nothing is
 * verified server-side, and a self-hosted install with no account can use it.
 */

/**
 * `Uint8Array<ArrayBuffer>`, not the default `Uint8Array<ArrayBufferLike>`.
 *
 * WebAuthn's `BufferSource` excludes `SharedArrayBuffer`, and TypeScript 5.7
 * made that distinction visible. Allocating the buffer explicitly is the
 * narrowing; a cast here would be the same lie with less typing.
 */
function bytes(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(length));
}

const PRF_SALT = ((): Uint8Array<ArrayBuffer> => {
  const encoded = new TextEncoder().encode("tmuxde/lock/v1 prf");
  const salt = bytes(encoded.length);
  salt.set(encoded);
  return salt;
})();

export type PrfSupport = "available" | "insecure-context" | "unsupported";

export function prfSupport(): PrfSupport {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure-context";
  if (!("credentials" in navigator) || !window.PublicKeyCredential) {
    return "unsupported";
  }
  return "available";
}

type PrfResults = { first?: ArrayBuffer };

function readPrf(credential: PublicKeyCredential): PrfResults | undefined {
  const results = credential.getClientExtensionResults() as {
    prf?: { enabled?: boolean; results?: PrfResults };
  };
  return results.prf?.results;
}

function prfEnabled(credential: PublicKeyCredential): boolean {
  const results = credential.getClientExtensionResults() as {
    prf?: { enabled?: boolean };
  };
  return results.prf?.enabled === true;
}

/**
 * A challenge that is generated locally and never verified.
 *
 * That looks wrong and is fine. The security of this factor comes from the PRF
 * secret plus `userVerification: "required"` — from the authenticator refusing
 * to produce the secret for the wrong person — not from anybody checking a
 * signature. There is no server in this flow to check one.
 */
function challenge(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(bytes(32));
}

export type EnrollResult =
  | { ok: true; credentialId: string; secret: Uint8Array }
  | { ok: false; reason: "no-prf"; credentialId: string }
  | { ok: false; reason: "cancelled" | "unsupported" };

/**
 * Enroll a passkey as a lock factor. **Two ceremonies, on purpose.**
 *
 * `navigator.credentials.create()` reports `prf.enabled` but does *not* return
 * `prf.results` — the spec allows an authenticator to advertise support at
 * registration without evaluating it. So the secret has to come from an
 * immediately following `get()`. The UI must warn "you will be asked twice"
 * before starting, or the second prompt reads as a bug and people cancel it.
 */
export async function enrollPasskeyFactor(userLabel: string): Promise<EnrollResult> {
  if (prfSupport() !== "available") {
    return { ok: false, reason: "unsupported" };
  }

  let created: PublicKeyCredential;
  try {
    created = (await navigator.credentials.create({
      publicKey: {
        challenge: challenge(),
        rp: { name: "tmuxde" },
        user: {
          // Local-only: this id is never sent anywhere and never correlated
          // with a tmuxde account.
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: userLabel,
          displayName: userLabel,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        timeout: 60_000,
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
  } catch {
    return { ok: false, reason: "cancelled" };
  }

  const credentialId = toBase64Url(created.rawId);

  // If PRF is not enabled the credential now **exists on the authenticator and
  // there is no API to delete it**. Saying so plainly is the only honest option
  // — the alternative is a stray passkey the user cannot explain or remove.
  if (!prfEnabled(created)) {
    return { ok: false, reason: "no-prf", credentialId };
  }

  const secret = await evaluatePrf(credentialId);
  if (!secret) return { ok: false, reason: "cancelled" };
  return { ok: true, credentialId, secret };
}

/** The second ceremony, and every later unlock: read the PRF secret. */
export async function evaluatePrf(credentialId: string): Promise<Uint8Array | null> {
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: challenge(),
        allowCredentials: [{ type: "public-key", id: fromBase64Url(credentialId) }],
        userVerification: "required",
        timeout: 60_000,
        extensions: {
          prf: { eval: { first: PRF_SALT } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!assertion) return null;
    const results = readPrf(assertion);
    if (!results?.first) return null;
    return new Uint8Array(results.first);
  } catch {
    return null;
  }
}

function toBase64Url(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = bytes(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
