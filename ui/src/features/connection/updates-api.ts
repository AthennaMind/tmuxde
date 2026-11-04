import { UpdateJobSchema, UpdateStatusSchema, StartUpdateSchema } from "@/protocol/updates";
import { resolveRelayHttpBase } from "./relay-url";
import { readSelfHostedToken } from "./storage-keys";

async function request(
  path: string,
  method: "GET" | "POST",
  signal?: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  const base = resolveRelayHttpBase();
  const token = readSelfHostedToken();
  if (!base || !token) throw new Error("Sign in to manage updates");
  const options: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    signal,
  };
  if (method === "POST" && body !== undefined) options.body = JSON.stringify(body);
  // oxlint-disable-next-line no-restricted-globals -- authenticated update requests stay in connection helpers.
  const response = await fetch(`${base}/updates${path}`, options);
  if (!response.ok) {
    const message = (await response.text()).slice(0, 500).trim();
    throw new Error(message || `Update request failed (${response.status})`);
  }
  return response.json();
}

/** Reads local state only. This never asks GitHub for a release. */
export async function getUpdateStatus(signal?: AbortSignal) {
  return UpdateStatusSchema.parse(await request("", "GET", signal));
}

/** Call only from explicit Check for updates action. */
export async function checkForUpdates(signal?: AbortSignal) {
  return UpdateStatusSchema.parse(await request("/check", "POST", signal));
}

export async function startUpdate(
  id: string,
  snapshot: string,
  targets: string[],
  signal?: AbortSignal,
) {
  const body = StartUpdateSchema.parse({ id, snapshot, targets });
  return UpdateJobSchema.parse(await request("/jobs", "POST", signal, body));
}

export async function cancelUpdate(id: string, signal?: AbortSignal) {
  return UpdateStatusSchema.parse(
    await request(`/jobs/${encodeURIComponent(id)}/cancel`, "POST", signal),
  );
}
