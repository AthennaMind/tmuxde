// Bound clipboard writes before decoding. OSC parser has its own larger limit.
const MAX_CLIPBOARD_BYTES = 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_CLIPBOARD_BYTES / 3);

/** Decode OSC 52 writes. Queries never read or expose browser clipboard. */
export function decodeOsc52(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator < 0 || !/^[cpsq0-7]*$/.test(data.slice(0, separator))) {
    return null;
  }
  const encoded = data.slice(separator + 1);
  if (!encoded || encoded === "?" || encoded.length > MAX_BASE64_LENGTH) {
    return null;
  }
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    if (bytes.length > MAX_CLIPBOARD_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
