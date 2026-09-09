"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/components/ui/alert-dialog";
import { Button } from "@repo/ui/components/ui/button";
import { limitsFor } from "@repo/config/plans";
import { toast } from "sonner";
import { useOnboarding } from "@/hooks/use-onboarding";
import { useServers } from "@/hooks/use-servers";
import { useMachinePrefs } from "@/hooks/use-machine-prefs";
import { useMachineActions } from "@/hooks/use-machine-actions";
import {
  SERVERS_POLL_MS,
  useVisibleInterval,
} from "@/hooks/use-visible-interval";
import type { RenameResult } from "@/hooks/use-inline-rename";
import { InstallMachine } from "@/components/entry/install-machine";
import { AllSessions } from "./all-sessions";
import {
  GettingStarted,
  SecondCredentialBanner,
} from "./getting-started";
import { RequestAccessDialog } from "./request-access-dialog";
import {
  ForgetMachineDialog,
  RemoveMachineDialog,
} from "./forget-machine-dialog";
import type { RegisteredServer } from "./registered-server";

/**
 * The dashboard, with one card per machine.
 *
 * ## One list
 *
 * It used to render every machine twice. `AllSessions` listed them all — paired
 * ones as session groups, unpaired ones as an invitation — and `ServerList`
 * then listed the same machines again under a collapsed "Manage machines"
 * section, so two machines produced four cards. Everything the second list
 * could do now lives on the card, and `ServerList` / `ServerRow` are deleted.
 *
 * That is not tidying. Two parallel UIs for one noun meant every fix had to be
 * made twice, and the two places it was not made are exactly the bugs that
 * shipped: the card destroyed a machine's device keys with no confirmation
 * while the row asked first, and the card's disclosure pointed `aria-controls`
 * at an id that was not in the document while the section below it got the
 * pattern right.
 *
 * ## Why the state lives here
 *
 * The fetch, the poll, the request dialog, the rename and the destructive
 * confirms all live at the page rather than in a card. The request dialog
 * especially: the broker allows one live request per device, so N mounted
 * dialogs would be N ways to race each other into a 409.
 */

/**
 * What a rename is being applied to.
 *
 * Two ids because there are two names. `accountId` is the registry row, shared
 * by every device on the account and gated behind Pro. `serverId` is this
 * browser's own key for the machine, which is free, works offline, and is the
 * only name a self-hosted pairing has ever had. Either may be absent: a machine
 * on the account this device has never paired with has no `serverId`, and a
 * self-hosted pairing has no `accountId`.
 */
export type RenameTarget = {
  accountId: string | null;
  serverId: string | null;
  current: string;
};

/**
 * Why the account refused this rename.
 *
 * The broker's own sentence when it sent one — it is the authority, it knows
 * about trials, and since `entitlements.ts` was corrected it says "machine"
 * like the rest of this page. But it was rendered *unconditionally*, so a 402
 * with an empty body, a proxy that ate the JSON, or any future refusal that
 * arrives without a reason produced a dialog with a title and a blank
 * paragraph under it.
 *
 * The fallback is **derived** from `plans.ts` rather than restated. Invariant 7
 * says the limits live in exactly one file, and the way that invariant actually
 * gets broken is not by someone writing `servers: 1` in a component — it is by
 * someone writing a sentence that means `servers: 1` and then nobody updating
 * it when the plan changes. So the branch reads `namedServers`, and the machine
 * allowance is interpolated rather than typed out.
 */
function upgradeReason(fromBroker: string | undefined): string {
  const trimmed = fromBroker?.trim();
  if (trimmed) return trimmed;

  const free = limitsFor("free");
  if (free.namedServers) {
    // The plan changed under this dialog: naming is free now, so whatever was
    // refused, it was not this.
    return "That name could not be saved on your account.";
  }
  const allowance =
    free.servers === null
      ? "as many machines as you like"
      : `${free.servers} machine${free.servers === 1 ? "" : "s"}`;
  return (
    `On the free plan a machine keeps its hostname. Free covers ${allowance}; ` +
    "Pro lifts that and lets you call each one whatever you like."
  );
}

export function DashboardBody() {
  const servers = useServers();
  const machines = useMachinePrefs();
  const [requesting, setRequesting] = useState<RegisteredServer | null>(null);
  /** Set when the account refused a rename because of the plan. */
  const [upgrade, setUpgrade] = useState<{
    message: string;
    target: RenameTarget;
    name: string;
  } | null>(null);

  /**
   * Bumped when this browser's keys change under the census's feet.
   *
   * The census re-runs when the machine *list* changes, which is the right
   * trigger for almost everything — but forgetting a machine changes neither
   * its id nor its `online`, so the card went on claiming a pairing whose keys
   * had just been deleted until something else forced a re-probe.
   */
  const [censusNonce, setCensusNonce] = useState(0);

  /**
   * How many sessions the census found, reported up by `AllSessions`.
   *
   * The checklist's last step is "open a session", and the census is the only
   * place that knows. Lifting the number is cheaper than running the fan-out a
   * second time — it opens a socket per machine and spends metered relay bytes.
   */
  const [sessionCount, setSessionCount] = useState(0);
  const onboarding = useOnboarding({ servers, sessionCount });

  /**
   * Step 3 opens the same dialog a machine card opens, deliberately.
   *
   * Preferring an online machine: the request goes over that machine's live
   * socket, so aiming the checklist at an offline one produces a dialog that
   * can only fail. With nothing online it still opens on the first machine,
   * whose dialog explains that better than a disabled button would.
   */
  const startPairing = useCallback(() => {
    const target =
      servers.servers.find((s) => s.online) ?? servers.servers[0] ?? null;
    setRequesting(target);
  }, [servers.servers]);

  const actions = useMachineActions({
    servers,
    machines,
    onForgotten: () => setCensusNonce((n) => n + 1),
  });

  /**
   * Keep `online` honest.
   *
   * `GET /v1/servers` was fetched once, on mount, and never again — so someone
   * who opened this page and *then* started `mtmux` on their laptop saw "Pair
   * this device" disabled forever, with no recovery but a hard reload. That is
   * a hard block on getting a new phone onto an account, which is one of the
   * most common reasons this page is opened at all.
   *
   * Background mode, so a poll never flashes skeletons over the list and one
   * failed poll never replaces it with an error card. And **only** the machine
   * list is on the timer: `runCensus` opens a socket per machine and spends
   * metered relay bytes, so it is never polled. It re-runs for free when
   * `online` flips, because `AllSessions` keys its effect on that — and with
   * `force = false`, so a machine whose cache is fresh costs nothing.
   */
  useVisibleInterval(() => {
    void servers.refresh({ background: true });
  }, SERVERS_POLL_MS);

  /**
   * Rename, wherever the name actually lives.
   *
   * The account first when there is one, because that name is what every other
   * device sees. When the plan refuses it, the offer is no longer just "see
   * Pro" — this device can still name the machine for itself, which is free and
   * is what most people wanted from the button.
   */
  async function handleRename(
    target: RenameTarget,
    name: string,
  ): Promise<RenameResult> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === target.current) return { ok: true };

    if (target.accountId) {
      const outcome = await servers.rename(target.accountId, trimmed);
      if (outcome.ok) {
        // A local rename would shadow the account name from here on, which is
        // not what someone who just renamed it on the account meant.
        if (target.serverId) await machines.clearName(target.serverId);
        toast.success(`Renamed to ${trimmed}`);
        return { ok: true };
      }
      if (outcome.kind === "upgrade") {
        setUpgrade({ message: outcome.message, target, name: trimmed });
        // `null`, because the dialog that just opened is saying it. A second
        // copy of the same refusal under the input would be noise.
        return { ok: false, message: null };
      }
      // Not a toast. The field stays open with what they typed, and the message
      // belongs under it — a four-second toast over an input the user is still
      // looking at is the worst of both.
      return { ok: false, message: outcome.message };
    }

    if (!target.serverId) {
      return { ok: false, message: "There is no name to change on this one." };
    }
    await machines.rename(target.serverId, trimmed);
    toast.success(`Renamed to ${trimmed} on this device`);
    return { ok: true };
  }

  async function renameLocallyInstead() {
    if (!upgrade?.target.serverId) return;
    await machines.rename(upgrade.target.serverId, upgrade.name);
    setUpgrade(null);
    toast.success(`Renamed to ${upgrade.name} on this device`, {
      description: "Your other devices still see the old name.",
    });
  }

  return (
    <>
      <header className="mb-5">
        {/* One noun. It was "Servers" in the header nav, "Your sessions" here
            and "Your machines" one section down — three words for one thing,
            on one page. */}
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Your machines
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Gathered by this browser, straight from each machine. mtmux&apos;s
          servers never see a session name.
        </p>
      </header>

      {/* Above the list, not instead of it: someone with six machines and a
          half-finished checklist needs both. */}
      <GettingStarted
        state={onboarding}
        onPair={startPairing}
        installSlot={<InstallMachine withLogin className="max-w-sm" />}
      />
      <SecondCredentialBanner state={onboarding} />

      <AllSessions
        servers={servers.servers}
        serversReady={servers.phase !== "loading"}
        serversStale={servers.staleSince !== null}
        censusNonce={censusNonce}
        onRequestAccess={setRequesting}
        machines={machines}
        onRename={handleRename}
        onForget={actions.askForget}
        onRemove={(server) =>
          actions.askRemove({
            id: server.id,
            publicKey: server.publicKey,
            name: server.name,
          })
        }
        // Background mode even though a human pressed the button: a foreground
        // refresh flips `phase` to "loading", which flips `serversReady` off
        // and back on, which re-triggers the census effect — so the one census
        // the button meant to run would have been two.
        onRefreshServers={() => servers.refresh({ background: true })}
        onCensusTotal={setSessionCount}
        // While the checklist is up it *is* the empty state — otherwise the
        // page shows "No machines here yet" directly under a list of steps
        // whose second one is how to fix that.
        emptyState={onboarding.visible ? <></> : undefined}
      />

      <RequestAccessDialog
        server={requesting}
        onOpenChange={(open) => {
          if (!open) setRequesting(null);
        }}
        onPaired={() => {
          // Re-read which machines this browser holds keys for, so the card
          // flips from an invitation to a session list without a reload.
          void servers.refreshPaired();
          void machines.reload();
        }}
      />

      <ForgetMachineDialog
        machineName={actions.pendingForget?.name ?? null}
        onOpenChange={(open) => {
          if (!open) actions.cancelForget();
        }}
        onConfirm={() => void actions.confirmForget()}
      />

      <RemoveMachineDialog
        machineName={actions.pendingRemove?.name ?? null}
        busy={actions.removing}
        onOpenChange={(open) => {
          if (!open) actions.cancelRemove();
        }}
        onConfirm={() => void actions.confirmRemove()}
      />

      <AlertDialog
        open={upgrade !== null}
        onOpenChange={(open) => !open && setUpgrade(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <Sparkles className="h-5 w-5 text-primary" aria-hidden />
            </div>
            <AlertDialogTitle>
              Naming machines is a Pro feature
            </AlertDialogTitle>
            <AlertDialogDescription>
              {upgradeReason(upgrade?.message)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* The free thing that was always possible and never offered: the
              name can live on this device, where nothing is gated. */}
          {upgrade?.target.serverId && (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-sm text-muted-foreground">
                Or name it just for this browser. It stays on this device — your
                other devices keep seeing {upgrade.target.current}.
              </p>
              <Button
                variant="outline"
                className="mt-3 h-11 w-full"
                onClick={() => void renameLocallyInstead()}
              >
                Call it &ldquo;{upgrade.name}&rdquo; on this device
              </Button>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">Not now</AlertDialogCancel>
            <AlertDialogAction asChild className="h-11">
              <Link href="/settings/billing">See Pro</Link>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
