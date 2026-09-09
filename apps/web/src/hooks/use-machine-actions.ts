"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiFetch } from "@/lib/auth-client";
import { deviceIdForPublicKey } from "@/components/account/connect-to-server";
import type { MachinePrefsState } from "@/hooks/use-machine-prefs";
import type { ServersState } from "@/hooks/use-servers";

/**
 * The two destructive things you can do to a machine, and the confirm policy
 * that has to sit in front of both.
 *
 * ## Why the policy is a hook rather than a convention
 *
 * "Forget on this device" existed on three surfaces and confirmed on two of
 * them. The one that did not was the session card — the surface people actually
 * use — so the most-used path was the only one that destroyed keys on a single
 * tap. Nobody decided that; the dialog was copied and one copy arrived without
 * it. A convention cannot prevent that. A hook that owns `pendingForget` can,
 * because there is no way to reach the effect without going through the state
 * that gates it.
 *
 * ## The bug the shared handler also fixes
 *
 * The card's forget updated the device's own prefs and stopped there, never
 * calling `servers.refreshPaired()`. `pairedKeys` therefore still claimed the
 * browser held keys for a machine whose keys had just been deleted, so the two
 * lists on the page disagreed about the same machine until a reload. Doing it
 * here means every caller gets the refresh whether or not they remembered it.
 */
export type MachineActions = {
  /** The machine awaiting a "yes, forget it", or null. */
  pendingForget: { serverId: string; name: string } | null;
  askForget: (serverId: string, name: string) => void;
  cancelForget: () => void;
  confirmForget: () => Promise<void>;

  /** The machine awaiting a "yes, remove it from the account", or null. */
  pendingRemove: { id: string; publicKey: string; name: string } | null;
  removing: boolean;
  askRemove: (server: { id: string; publicKey: string; name: string }) => void;
  cancelRemove: () => void;
  confirmRemove: () => Promise<void>;
};

export function useMachineActions({
  servers,
  machines,
  onForgotten,
}: {
  servers: ServersState;
  machines: MachinePrefsState;
  /** Called after keys are gone, so a list built from them can rebuild. */
  onForgotten?: () => void;
}): MachineActions {
  const [pendingForget, setPendingForget] = useState<{
    serverId: string;
    name: string;
  } | null>(null);
  const [pendingRemove, setPendingRemove] = useState<{
    id: string;
    publicKey: string;
    name: string;
  } | null>(null);
  const [removing, setRemoving] = useState(false);

  const confirmForget = useCallback(async () => {
    const target = pendingForget;
    if (!target) return;
    setPendingForget(null);
    await machines.forget(target.serverId);
    // The half the card used to skip. Without it `pairedKeys` still says this
    // browser holds keys it has just deleted.
    await servers.refreshPaired();
    onForgotten?.();
    toast.success(`Forgot ${target.name} on this device`, {
      description: "It stays on your account. Pair with it again any time.",
    });
  }, [machines, onForgotten, pendingForget, servers]);

  const confirmRemove = useCallback(async () => {
    const target = pendingRemove;
    if (!target) return;
    setRemoving(true);
    try {
      await apiFetch(`/v1/servers/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
      });
      servers.remove(target.id);
      // The account row is gone, so this device's keys for it are dead weight —
      // and its local name would otherwise outlive the machine it named.
      const serverId = deviceIdForPublicKey(target.publicKey);
      if (serverId) await machines.forget(serverId);
      await servers.refreshPaired();
      onForgotten?.();
      toast.success(`Removed ${target.name}`);
      setPendingRemove(null);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not remove that machine.",
      );
    } finally {
      setRemoving(false);
    }
  }, [machines, onForgotten, pendingRemove, servers]);

  return {
    pendingForget,
    askForget: useCallback(
      (serverId, name) => setPendingForget({ serverId, name }),
      [],
    ),
    cancelForget: useCallback(() => setPendingForget(null), []),
    confirmForget,
    pendingRemove,
    removing,
    askRemove: useCallback((server) => setPendingRemove(server), []),
    cancelRemove: useCallback(() => setPendingRemove(null), []),
    confirmRemove,
  };
}
