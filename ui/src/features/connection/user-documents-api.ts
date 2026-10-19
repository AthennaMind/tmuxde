import { userDocumentPath, type UserDocumentName } from "@/protocol";
import { resolveRelayHttpBase } from "./relay-url";
import { readSelfHostedToken } from "./storage-keys";

/**
 * Client for the hub's user documents, `GET` and `PUT /user/{name}`.
 *
 * The hub keeps `settings.json` and `keybindings.json` beside its machine
 * registry and serves them to every browser. Both calls return a result
 * instead of throwing, so the documents store can show each case.
 */

export type UserDocumentResult =
  | { kind: "ok"; text: string; etag: string }
  /** 412. The `If-Match` etag is stale. */
  | { kind: "conflict" }
  /** 400 with the server's reason, or a request the server cannot take. */
  | { kind: "invalid"; message: string }
  | { kind: "unauthorized" }
  | { kind: "notFound" }
  /** 413. Over the hub's body limit. */
  | { kind: "tooLarge" }
  /** No answer, or an answer this client does not expect. */
  | { kind: "network"; message: string; status?: number };

export function getUserDocument(
  name: UserDocumentName,
  signal?: AbortSignal,
): Promise<UserDocumentResult> {
  return request(name, { method: "GET", signal });
}

export interface PutOptions {
  signal?: AbortSignal;
  /** Let the request outlive the page, for a save on page hide. */
  keepalive?: boolean;
}

/**
 * Browsers cap the body of keepalive requests at 64 KiB. A larger document
 * goes out as a plain request, which an unload may cancel.
 */
const KEEPALIVE_MAX_BYTES = 64 * 1024;

/**
 * Replace a document. `etag` goes into `If-Match`. `*` overwrites any copy.
 *
 * The token is read and the request sent before this returns. A caller that
 * runs it right before a lock still sends with the token.
 */
export function putUserDocument(
  name: UserDocumentName,
  text: string,
  etag: string,
  options: PutOptions = {},
): Promise<UserDocumentResult> {
  const keepalive =
    options.keepalive === true && new TextEncoder().encode(text).length <= KEEPALIVE_MAX_BYTES;
  return request(name, { method: "PUT", body: text, etag, signal: options.signal, keepalive });
}

async function request(
  name: UserDocumentName,
  options: {
    method: "GET" | "PUT";
    body?: string;
    etag?: string;
    signal?: AbortSignal;
    keepalive?: boolean;
  },
): Promise<UserDocumentResult> {
  // Everything up to `fetch` runs before the first await. Keep it so, or a
  // save started on lock reads the token after it is gone.
  const base = resolveRelayHttpBase();
  if (!base) return { kind: "network", message: "Server address unavailable" };
  const token = readSelfHostedToken();
  if (!token) return { kind: "unauthorized" };

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (options.method === "PUT") {
    headers["Content-Type"] = "application/json";
    headers["If-Match"] = options.etag ?? "*";
  }

  let response: Response;
  try {
    // oxlint-disable-next-line no-restricted-globals -- sanctioned user settings request, token stays in the header.
    response = await fetch(`${base}${userDocumentPath(name)}`, {
      method: options.method,
      headers,
      body: options.body,
      cache: "no-store",
      signal: options.signal,
      ...(options.keepalive ? { keepalive: true } : {}),
    });
  } catch (error) {
    return { kind: "network", message: errorMessage(error) };
  }

  if (response.ok) {
    const etag = response.headers.get("ETag");
    if (!etag) return { kind: "network", message: "Response had no ETag", status: response.status };
    if (options.method === "PUT") return { kind: "ok", text: options.body ?? "", etag };
    try {
      return { kind: "ok", text: await response.text(), etag };
    } catch (error) {
      return { kind: "network", message: errorMessage(error), status: response.status };
    }
  }

  switch (response.status) {
    case 400:
      return { kind: "invalid", message: (await bodyText(response)) || "Invalid document" };
    case 401:
      return { kind: "unauthorized" };
    case 404:
      return { kind: "notFound" };
    case 412:
      return { kind: "conflict" };
    case 413:
      return { kind: "tooLarge" };
    case 428:
      return { kind: "invalid", message: "If-Match header required" };
    default:
      return {
        kind: "network",
        message: `Request failed (${response.status})`,
        status: response.status,
      };
  }
}

async function bodyText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Network error";
}
