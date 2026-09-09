"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronsUpDown,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Loader2,
  Pencil,
  PlugZap,
  Server,
  Trash2,
  X,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/ui/components/ui/sheet";
import { Button } from "@repo/ui/components/ui/button";
import { Input } from "@repo/ui/components/ui/input";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { cn } from "@repo/ui/lib/utils";
import { toast } from "sonner";
import { apiFetch, isHostedBuild } from "@/lib/auth-client";
import { deviceIdForPublicKey } from "@/components/account/connect-to-server";
import { FORGET_MACHINE_BODY } from "@/components/account/forget-machine-dialog";
import {
  listMachines,
  moveMachine,
  renameMachine,
  type MachineEntry,
} from "@/lib/machine-directory";
import { forgetMachine } from "@/lib/forget-machine";
import {
  activateDescriptor,
  loadDescriptor,
  serverIdFor,
} from "@/lib/session-store";
import { useUiStore } from "@/stores/ui-store";

/**
 * Which machine you are on, and every other one you could be on.
 *
 * Before this, the only route from the terminal to the machines was: open
 * Settings, scroll to the bottom, tap "Your machines", land on the dashboard,
 * find the row, press Open. Five steps to switch between two machines, and on
 * mobile the middle three were the only ones — the desktop header's Machines
 * link is hidden below 768px.
 *
 * It also carries the things that had nowhere else to live on a phone: rename,
 * reorder, and forget-on-this-device. Rename here is local (see
 * `machine-directory.ts`); the account's own name is Pro-gated and does not
 * exist at all for a self-hosted pairing, so a browser that could not rename
 * *anything* was the wrong answer for both.
 */
export function MachineSwitcher({ className }: { className?: string }) {
  const open = useUiStore((s) => s.machineSwitcherOpen);
  const setOpen = useUiStore((s) => s.setMachineSwitcherOpen);
  const [machines, setMachines] = useState<MachineEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const session = loadDescriptor();
      setActiveId(session ? serverIdFor(session.descriptor) : null);
      setMachines(await listMachines(await accountNames()));
    } finally {
      setLoading(false);
    }
  }, []);

  // Loaded once for the header label, and again whenever the sheet opens so a
  // rename made on the dashboard in another tab is not stale here.
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const active = machines.find((m) => m.serverId === activeId) ?? null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Switch machine"
        className={cn(
          "flex min-w-0 max-w-40 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors",
          "hover:bg-accent hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      >
        <Server className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{active?.name ?? "Machine"}</span>
        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
      </button>

      <MachineSheet
        open={open}
        onOpenChange={setOpen}
        machines={machines}
        activeId={activeId}
        loading={loading}
        onChanged={load}
      />
    </>
  );
}

/**
 * The account's names, when there are any.
 *
 * Best-effort on purpose: signed out, offline, or self-hosted all mean "no
 * account names", which is not an error — it is the normal case for half the
 * product. The hostname from the pairing is always there as the fallback.
 */
async function accountNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!isHostedBuild) return names;
  try {
    const body = await apiFetch<{
      servers?: { name?: unknown; publicKey?: unknown }[];
    }>("/v1/servers");
    for (const raw of body.servers ?? []) {
      if (typeof raw.publicKey !== "string" || typeof raw.name !== "string") {
        continue;
      }
      const id = deviceIdForPublicKey(raw.publicKey);
      if (id && raw.name) names.set(id, raw.name);
    }
  } catch {
    // Signed out or unreachable.
  }
  return names;
}

function MachineSheet({
  open,
  onOpenChange,
  machines,
  activeId,
  loading,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machines: MachineEntry[];
  activeId: string | null;
  loading: boolean;
  onChanged: () => Promise<void>;
}) {
  const [switching, setSwitching] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pendingForget, setPendingForget] = useState<string | null>(null);

  async function handleSwitch(entry: MachineEntry) {
    if (entry.serverId === activeId) {
      onOpenChange(false);
      return;
    }
    setSwitching(entry.serverId);
    const session = await activateDescriptor(entry.serverId);
    if (!session) {
      setSwitching(null);
      toast.info("Not available yet", {
        description:
          "This browser no longer holds keys for that machine. Pair with it " +
          "again to open it from here.",
      });
      void onChanged();
      return;
    }
    /*
     * A full document load, for the reason `all-sessions.tsx` documents at
     * length: three Zustand stores hold the previous machine's sessions, panes
     * and capabilities, none has a reset path, and all three repopulate only
     * once the new relay answers. A soft navigation would paint another
     * machine's session names for a beat, on a product whose premise is that
     * session names never leave the device that owns them.
     */
    window.location.assign("/");
  }

  async function handleMove(serverId: string, direction: -1 | 1) {
    await moveMachine(
      machines.map((m) => m.serverId),
      serverId,
      direction,
    );
    await onChanged();
  }

  async function handleForget(serverId: string) {
    await forgetMachine(serverId);
    setPendingForget(null);
    toast.success("Forgotten on this device", {
      description: "Pair with it again whenever you like.",
    });
    // Forgetting the machine you are looking at leaves the terminal with keys
    // it can no longer load, which the layout's guard reads as "no session".
    // Sending them to the entry page is the honest end to that.
    if (serverId === activeId) {
      window.location.assign("/start");
      return;
    }
    await onChanged();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex h-[75vh] flex-col px-4 pt-4">
        <SheetHeader className="pb-2 text-left">
          <SheetTitle className="text-sm">Machines</SheetTitle>
          <SheetDescription className="text-xs">
            Everything this browser holds keys for. Tap one to switch to it.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="-mx-4 h-0 flex-1 px-4">
          <div className="space-y-2 pb-4">
            {loading && machines.length === 0 && (
              <div
                className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Looking for paired machines…
              </div>
            )}

            {!loading && machines.length === 0 && (
              <p className="py-6 text-sm text-muted-foreground">
                No machines paired on this device yet.
              </p>
            )}

            {machines.map((entry, index) => (
              <MachineRow
                key={entry.serverId}
                entry={entry}
                active={entry.serverId === activeId}
                switching={switching === entry.serverId}
                editing={editing === entry.serverId}
                confirmingForget={pendingForget === entry.serverId}
                first={index === 0}
                last={index === machines.length - 1}
                onSwitch={() => void handleSwitch(entry)}
                onStartEditing={() =>
                  setEditing(editing === entry.serverId ? null : entry.serverId)
                }
                onRename={async (name) => {
                  await renameMachine(entry.serverId, name);
                  setEditing(null);
                  await onChanged();
                }}
                onMove={(direction) =>
                  void handleMove(entry.serverId, direction)
                }
                onAskForget={() =>
                  setPendingForget(
                    pendingForget === entry.serverId ? null : entry.serverId,
                  )
                }
                onForget={() => void handleForget(entry.serverId)}
              />
            ))}
          </div>
        </ScrollArea>

        <div className="flex shrink-0 gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            className="h-11 flex-1"
            onClick={() => window.location.assign("/start")}
          >
            <PlugZap className="h-4 w-4" aria-hidden />
            Pair another
          </Button>
          {isHostedBuild && (
            <Button
              variant="outline"
              className="h-11 flex-1"
              onClick={() => window.location.assign("/dashboard")}
            >
              <LayoutGrid className="h-4 w-4" aria-hidden />
              Manage
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MachineRow({
  entry,
  active,
  switching,
  editing,
  confirmingForget,
  first,
  last,
  onSwitch,
  onStartEditing,
  onRename,
  onMove,
  onAskForget,
  onForget,
}: {
  entry: MachineEntry;
  active: boolean;
  switching: boolean;
  editing: boolean;
  confirmingForget: boolean;
  first: boolean;
  last: boolean;
  onSwitch: () => void;
  onStartEditing: () => void;
  onRename: (name: string) => Promise<void>;
  onMove: (direction: -1 | 1) => void;
  onAskForget: () => void;
  onForget: () => void;
}) {
  const [draft, setDraft] = useState(entry.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(entry.name);
      inputRef.current?.focus();
    }
  }, [editing, entry.name]);

  return (
    <div
      className={cn(
        "rounded-lg border transition-colors",
        active ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <div className="flex items-center gap-1 p-2">
        {editing ? (
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void onRename(draft);
            }}
          >
            <Input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onStartEditing();
              }}
              maxLength={64}
              className="h-11"
              aria-label={`Name for ${entry.name}`}
            />
            <Button type="submit" size="icon" className="h-11 w-11 shrink-0">
              <Check className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-11 w-11 shrink-0"
              onClick={onStartEditing}
              aria-label="Cancel rename"
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={onSwitch}
              disabled={switching}
              className={cn(
                "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  active ? "bg-success" : "bg-muted-foreground/40",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">
                  {entry.name}
                </span>
                {/* Shown only when it differs, so the row does not repeat
                    itself for the overwhelmingly common case. */}
                {entry.renamedHere && entry.hostname !== entry.name && (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {entry.hostname}
                  </span>
                )}
              </span>
              {switching ? (
                <Loader2
                  className="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
                  aria-hidden
                />
              ) : active ? (
                <span className="shrink-0 text-[11px] text-primary">
                  current
                </span>
              ) : null}
            </button>

            <div className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-9"
                disabled={first}
                onClick={() => onMove(-1)}
                aria-label={`Move ${entry.name} up`}
              >
                <ChevronUp className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-9"
                disabled={last}
                onClick={() => onMove(1)}
                aria-label={`Move ${entry.name} down`}
              >
                <ChevronDown className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-9"
                onClick={onStartEditing}
                aria-label={`Rename ${entry.name}`}
              >
                <Pencil className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-9 text-muted-foreground hover:text-destructive"
                onClick={onAskForget}
                aria-label={`Forget ${entry.name} on this device`}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Inline rather than a dialog: a sheet that opens a dialog on a phone
          stacks two overlays over the terminal, and the second one has to be
          dismissed before the first makes sense again. */}
      {confirmingForget && (
        <div className="space-y-2 border-t border-border px-3 py-3">
          {/* The same sentence the dashboard's dialog uses, imported rather
              than retyped. Copying this copy is how the dashboard's session
              card ended up with no confirmation at all while two other
              surfaces had one. */}
          <p className="text-xs text-muted-foreground">{FORGET_MACHINE_BODY}</p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="h-11 flex-1"
              onClick={onAskForget}
            >
              Keep it
            </Button>
            <Button
              className="h-11 flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onForget}
            >
              Forget
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
