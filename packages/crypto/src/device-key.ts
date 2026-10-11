import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bytesToHex, hexToBytes, randomBytes } from "./bytes";

/**
 * Long-lived device identity.
 *
 * Each CLI install and each browser profile generates one Ed25519 keypair the
 * first time it pairs. After that, reconnecting a known device is a signed
 * challenge rather than another six-digit code — the code is needed exactly
 * once, ever — and revocation is just forgetting a public key.
 */

const CHALLENGE_DOMAIN = utf8ToBytes("tmuxde/v1 device-challenge");
export const CHALLENGE_BYTES = 32;

export type DeviceKeyPair = {
  /** Short, stable, human-quotable id: the first 8 bytes of the key hash. */
  deviceId: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

/** A device id is a fingerprint of the public key, not a random label. */
export function deviceIdFor(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey).subarray(0, 8));
}

export function generateDeviceKey(): DeviceKeyPair {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return { deviceId: deviceIdFor(publicKey), publicKey, secretKey };
}

export function newChallenge(): Uint8Array {
  return randomBytes(CHALLENGE_BYTES);
}

/**
 * Sign a challenge, domain-separated so a signature produced here can never be
 * replayed as a signature over some other protocol's message.
 */
export function signChallenge(
  secretKey: Uint8Array,
  challenge: Uint8Array,
): Uint8Array {
  return ed25519.sign(concatBytes(CHALLENGE_DOMAIN, challenge), secretKey);
}

export function verifyChallenge(
  publicKey: Uint8Array,
  challenge: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return ed25519.verify(
      signature,
      concatBytes(CHALLENGE_DOMAIN, challenge),
      publicKey,
    );
  } catch {
    // Malformed signature or point — indistinguishable from a wrong one here.
    return false;
  }
}

/** Serialised form for ~/.tmuxde/config.json and IndexedDB. */
export type StoredDeviceKey = {
  deviceId: string;
  publicKey: string;
  secretKey: string;
};

export function encodeDeviceKey(pair: DeviceKeyPair): StoredDeviceKey {
  return {
    deviceId: pair.deviceId,
    publicKey: bytesToHex(pair.publicKey),
    secretKey: bytesToHex(pair.secretKey),
  };
}

export function decodeDeviceKey(stored: StoredDeviceKey): DeviceKeyPair {
  const publicKey = hexToBytes(stored.publicKey);
  const secretKey = hexToBytes(stored.secretKey);
  if (publicKey.length !== 32 || secretKey.length !== 32) {
    throw new Error("Stored device key is malformed");
  }
  // Recompute rather than trust the stored id: a mismatch means the file was
  // edited or corrupted, and silently honouring it would break revocation.
  const deviceId = deviceIdFor(publicKey);
  if (stored.deviceId && stored.deviceId !== deviceId) {
    throw new Error("Stored device id does not match its public key");
  }
  return { deviceId, publicKey, secretKey };
}
