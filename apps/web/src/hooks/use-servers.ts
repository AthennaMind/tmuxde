"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, apiFetch } from "@/lib/auth-client";
import { pairedServerKeys } from "@/components/account/connect-to-server";
import { toEpochMs } from "@/components/account/format";
import type { RegisteredServer } from "@/components/account/registered-server";

/**
 * The account's machines, fetched once for the whole page.
 *
 * `AllSessions` and the since-deleted `ServerList` used to each call `GET
 * /v1/servers` on mount, with two different normalizers, and each ran its own
 * 30-second clock tick and its own `pairedServerKeys` read. Two requests for
 * one answer is the small problem; two *different shapes* of the same answer is
 * the real one, because a machine could be online in one list and not the
 * other.
 *
 * The clock tick lives here for the same reason: it exists so "4m ago" stays
 * honest, and one timer does that for every consumer.
 */

type RawServer = Partial<Record<keyof RegisteredServer, unknown>>;

/** The broker sends `lastSeenAt` as epoch ms; tolerate an ISO string too. */
export function normalizeServer(raw: RawServer): RegisteredServer {
  return {
    id: String(raw.id ?? ""),
    name:
      typeof raw.name === "string" && raw.name ? raw.name : "Unnamed machine",
    slug: typeof raw.slug === "string" ? raw.slug : "",
    publicKey: typeof raw.publicKey === "string" ? raw.publicKey : "",
    online: raw.online === true,
    lastSeenAt: toEpochMs(raw.lastSeenAt),
    platform: typeof raw.platform === "string" ? raw.platform : null,
    cliVersion: typeof raw.cliVersion === "string" ? raw.cliVersion : null,
  };
}

/**
 * How a refresh should behave when nobody asked for it.
 *
 * A poll is not a page load, and treating it as one is how a working list gets
 * replaced by skeletons twice a minute and then by an error card the first time
 * a phone loses a bar of signal. See `refresh` below.
 */
export type RefreshOptions = { background?: boolean };

export type ServersState = {
  phase: "loading" | "ready" | "error";
  servers: RegisteredServer[];
  message: string | null;
  /**
   * When a background refresh last failed, in epoch ms — else null.
   *
   * The list on screen is still the last good one. This is how the UI says "and
   * it may be out of date" without throwing away the only thing it can show.
   */
  staleSince: number | null;
  /**
   * Public keys this browser holds keys for.
   *
   * Read from IndexedDB, never from the broker — which browsers can open which
   * machines is precisely the thing we do not want the server to know.
   */
  pairedKeys: Set<string>;
  /** Ticks every 30s, so relative timestamps stay honest without re-fetching. */
  now: number;
  refresh: (options?: RefreshOptions) => Promise<void>;
  /** Re-read the paired set, after a pairing completes. */
  refreshPaired: () => Promise<void>;
  /** Patch one machine locally, after a rename. */
  patch: (id: string, changes: Partial<RegisteredServer>) => void;
  /** Drop one machine locally, after a delete. */
  remove: (id: string) => void;
  /** Rename on the account. See `RenameOutcome` for why it is not a boolean. */
  rename: (id: string, name: string) => Promise<RenameOutcome>;
};

/**
 * Why this is not `Promise<boolean>`.
 *
 * A refused rename has two completely different meanings, and the caller has to
 * tell them apart to do the right thing. `"upgrade"` is the product describing
 * a plan — it deserves an offer, and now also a way to rename the machine on
 * this device instead, which costs nothing and nobody had to buy. `"error"` is
 * a failure, and gets a red toast.
 */
export type RenameOutcome =
  | { ok: true }
  | { ok: false; kind: "upgrade"; message: string }
  | { ok: false; kind: "error"; message: string };

export function useServers(): ServersState {
  const [phase, setPhase] = useState<ServersState["phase"]>("loading");
  const [servers, setServers] = useState<RegisteredServer[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pairedKeys, setPairedKeys] = useState<Set<string>>(() => new Set());
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /**
   * Fetch the account's machines.
   *
   * `background: true` is the polling mode, and every difference in it exists
   * because of what a poll must never do to a list the user is reading.
   *
   * It does not set `phase: "loading"`, because that flashes skeletons over a
   * perfectly good list every 45 seconds. It does not set `phase: "error"` or
   * clear `servers` on failure, because one flaky poll on a phone would then
   * replace a working dashboard with an error card — and the previous answer,
   * which is what the user is looking at, is still the best information we
   * have. A failure records `staleSince` and nothing else.
   */
  const refresh = useCallback(async ({ background }: RefreshOptions = {}) => {
    // Deliberately not gated on `isHostedBuild`. `apiFetch` resolves the base
    // itself, and this page is only ever reached behind `RequireSession` — so
    // gating here would leave a signed-in user staring at nothing on any build
    // whose API origin is same-origin rather than a separate host.
    if (!background) setPhase("loading");
    try {
      const body = await apiFetch<{ servers?: RawServer[] }>("/v1/servers");
      const next = Array.isArray(body.servers)
        ? body.servers.map(normalizeServer)
        : [];
      setServers(next);
      setMessage(null);
      setStaleSince(null);
      setPhase("ready");
    } catch (error) {
      const text =
        error instanceof ApiError
          ? error.message
          : "Could not load your machines.";
      if (background) {
        // Keep the list, keep `phase`. Only say that it is ageing.
        setStaleSince((since) => since ?? Date.now());
        return;
      }
      setMessage(text);
      setPhase("error");
    }
  }, []);

  const refreshPaired = useCallback(async () => {
    const keys = await pairedServerKeys(servers.map((s) => s.publicKey));
    setPairedKeys(keys);
  }, [servers]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    void pairedServerKeys(servers.map((s) => s.publicKey)).then((keys) => {
      if (!cancelled) setPairedKeys(keys);
    });
    return () => {
      cancelled = true;
    };
  }, [phase, servers]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const patch = useCallback(
    (id: string, changes: Partial<RegisteredServer>) => {
      setServers((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...changes } : s)),
      );
    },
    [],
  );

  const remove = useCallback((id: string) => {
    setServers((prev) => prev.filter((s) => s.id !== id));
  }, []);

  /**
   * Renaming used to live inside the management list, which is why only that
   * list could do it — the session cards above it, the ones people actually
   * look at, had no route to a rename at all.
   */
  const rename = useCallback(
    async (id: string, name: string): Promise<RenameOutcome> => {
      try {
        await apiFetch(`/v1/servers/${encodeURIComponent(id)}`, {
          method: "PATCH",
          json: { name },
        });
        patch(id, { name });
        return { ok: true };
      } catch (error) {
        if (error instanceof ApiError && error.status === 402) {
          return { ok: false, kind: "upgrade", message: error.message };
        }
        return {
          ok: false,
          kind: "error",
          message:
            error instanceof ApiError
              ? error.message
              : "Could not rename that machine.",
        };
      }
    },
    [patch],
  );

  return useMemo(
    () => ({
      phase,
      servers,
      message,
      staleSince,
      pairedKeys,
      now,
      refresh,
      refreshPaired,
      patch,
      remove,
      rename,
    }),
    [
      phase,
      servers,
      message,
      staleSince,
      pairedKeys,
      now,
      refresh,
      refreshPaired,
      patch,
      remove,
      rename,
    ],
  );
}
