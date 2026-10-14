import { resolveRelayHttpBase } from "@/lib/relay-url";

import { readSelfHostedToken } from "./storage-keys";

/**
 * Thrown when the current connection has no HTTP route to the relay.
 *
 * Distinguishing this from a transport failure matters: it is not retryable and
 * the UI should say so plainly rather than showing a network error.
 */
export class FilesUnavailableError extends Error {
  constructor() {
    super("Files are not available over the relay tunnel.");
    this.name = "FilesUnavailableError";
  }
}

/**
 * Read the credential for server HTTP requests (client side only). The token
 * from login, from localStorage or, with a lock, from memory.
 */
export function getStoredToken(): string {
  if (typeof window === "undefined") return "";
  return readSelfHostedToken() ?? "";
}

/** Whether `/file` requests can be made on this connection at all. */
export function filesAvailable(): boolean {
  return resolveRelayHttpBase() !== "";
}

/**
 * Build the `/file?path=..` URL WITHOUT the token in the query. Use this for
 * resources loaded via `fetchFileObjectUrl` (embedded media), where the token
 * travels in an `Authorization` header instead of leaking into the URL (and
 * thus into browser history, referrers, and server access logs).
 */
export function getFileUrl(path: string, download?: boolean): string {
  const httpBase = resolveRelayHttpBase();
  if (!httpBase) throw new FilesUnavailableError();
  const params = new URLSearchParams({ path });
  if (download) params.set("download", "1");
  return `${httpBase}/file?${params.toString()}`;
}

/**
 * Download a file, authenticating with a header rather than the URL.
 *
 * An `<a href download>` navigation cannot carry an `Authorization` header,
 * which is why the token used to travel in the query. Fetching the bytes and
 * handing the browser an object URL gets the same "save as" behaviour with the
 * credential never leaving the request headers.
 */
export async function downloadFile(
  path: string,
  fileName: string,
): Promise<void> {
  const objectUrl = await fetchFileObjectUrl(path);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoked on the next tick: revoking synchronously can beat the browser's
    // own read of the URL and produce an empty file.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

/**
 * Fetch a file as a blob using the `Authorization: Bearer <token>` header
 * (never the URL) and return an object URL. The caller MUST revoke the
 * returned URL on cleanup/unmount to avoid leaks — see `useFileObjectUrl`.
 */
export async function fetchFileObjectUrl(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const token = getStoredToken();
  const res = await fetch(getFileUrl(path), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok) {
    throw new Error(`Failed to load file (${res.status})`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
