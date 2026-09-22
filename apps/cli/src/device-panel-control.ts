import kleur from "kleur";

import {
  FLASH_MS,
  MAX_NAME_INPUT,
  buildRows,
  clamp,
  render,
  selected,
  type PanelMode,
  type PanelPeer,
  type PanelRow,
  type PanelState,
} from "./device-panel.js";
import { createKeyReader, KEY, type KeyReader } from "./keys.js";
import { createLiveView, type LiveView } from "./live-view.js";
import type { AccessPromptInput, AccessPromptResult } from "./access-prompt.js";
import type { ConnectedDevice } from "./serve.js";

/**
 * The live panel's moving parts: what it reads, what it does, and who owns
 * stdin while it is up.
 *
 * ## One owner of stdin, always
 *
 * `access-prompt.ts` opens a readline to ask its `[y/N]`, and its header
 * records what two readers on one stdin cost the last time: "a dead `[y/N]`
 * eating keystrokes on the machine" after the question had been answered on a
 * phone. So the panel does not co-exist with that prompt — it *is* that
 * prompt. `promptForAccess` below is handed to `decideAccess` through the
 * `prompt` seam it already has, the question is drawn as a panel mode, and the
 * same key reader that moves the cursor answers it.
 *
 * ## The tick, and why it is not always running
 *
 * Ages and the approval countdown change with the clock rather than with any
 * event, so something has to repaint on its own. But a timer that redraws the
 * bottom of the screen once a second forever is a process that never lets the
 * CPU idle and a terminal that never stops changing. So it runs only while
 * something on screen is actually time-dependent: a connected device, or a
 * live question. An idle machine with nothing connected draws once and stops.
 */

export type PanelDeps = {
  /** In-process connection list. Absent on a relay bundle that predates it. */
  details?: () => ConnectedDevice[];
  /** Fires when a device authenticates or drops. */
  subscribe?: (listener: () => void) => () => void;
  /** Hang up on one socket. */
  disconnect?: (id: string) => Promise<boolean>;
  /** Un-pair a device, permanently. */
  revoke?: (deviceId: string) => Promise<boolean>;
  /**
   * Every device this machine trusts, connected or not.
   *
   * Synchronous and cached by the caller rather than a promise, because it is
   * read on every repaint — once a second while anything is connected — and a
   * panel that awaited the config file to draw a row would be a panel that
   * blinks whenever the disk is busy.
   */
  peers?: () => PanelPeer[];
  /** Give a device a name of the owner's choosing. Null clears it. */
  rename?: (deviceId: string, name: string | null) => Promise<boolean>;
  /**
   * Whether a device that has paired before is asked about when it returns,
   * and a way to flip it while the server runs.
   *
   * On the panel because "it never asked me" is almost always this setting,
   * and a setting nobody can see is one nobody can be wrong about.
   */
  askOnReconnect?: () => boolean;
  setAskOnReconnect?: (value: boolean) => Promise<void>;
  /** Throw away the printed code and arm a fresh one. */
  rearm?: () => void;
  /**
   * Open the sealed tunnel on a machine that started local-only.
   *
   * Resolves with a failure message rather than throwing: the caller is a
   * keypress, there is nothing above it to catch, and the honest outcome of
   * "no route out" is a line on the panel and not a stack trace over the QR.
   */
  openTunnel?: () => Promise<string | null>;
  /** Reprint the banner above the panel. */
  reprint?: () => void;
  /** Ctrl+C, `q`, and the interrupt key all land here. */
  onQuit: () => void;
  /** Whether a tunnel is up, read at render time so a late one counts. */
  hosted: () => boolean;
  now?: () => number;
  view?: LiveView;
  keys?: KeyReader;
};

export type DevicePanel = {
  readonly enabled: boolean;
  /** Print above the panel. Everything `start` says goes through this. */
  log: (...lines: string[]) => void;
  /** Redraw — after a reprint, or when the tunnel comes up late. */
  refresh: () => void;
  /** `decideAccess`'s `prompt` seam, when the panel is up. */
  promptForAccess: (
    req: AccessPromptInput,
    signal: AbortSignal,
  ) => Promise<AccessPromptResult>;
  stop: () => void;
};

export function createDevicePanel(deps: PanelDeps): DevicePanel {
  const now = deps.now ?? Date.now;
  const view = deps.view ?? createLiveView();

  if (!view.enabled || !deps.details) {
    // No panel: a pipe, a service unit, `--json`, a terminal too short, or a
    // relay bundle that cannot list connections. `log` is a plain logger and
    // `promptForAccess` abstains so the readline prompt is used instead.
    return {
      enabled: false,
      log: (...lines) => view.log(...lines),
      refresh: () => {},
      promptForAccess: async () => ({ approved: false, reason: "no-tty" }),
      stop: () => view.stop(),
    };
  }

  const details = deps.details;
  let cursor = 0;
  let mode: PanelMode = { kind: "list" };
  let flash: string | null = null;
  let flashTimer: NodeJS.Timeout | null = null;
  /** True while a tunnel is being opened, so `t` cannot be pressed twice. */
  let opening = false;
  let tick: NodeJS.Timeout | null = null;
  let stopped = false;
  /** Resolver for the question currently on screen, if any. */
  let answering: ((result: AccessPromptResult) => void) | null = null;

  const keys =
    deps.keys ??
    createKeyReader({
      onInterrupt: () => {
        stop();
        deps.onQuit();
      },
    });

  function rows(): PanelRow[] {
    return buildRows(details(), deps.peers?.() ?? []);
  }

  function state(): PanelState {
    const list = rows();
    return {
      rows: list,
      cursor: clamp(cursor, list.length),
      mode,
      flash,
      now: now(),
      hosted: deps.hosted(),
      canOpenTunnel: !deps.hosted() && deps.openTunnel !== undefined,
      askOnReconnect: deps.askOnReconnect?.() ?? false,
      frozen: stopped,
    };
  }

  function paint(): void {
    if (stopped) return;
    view.setPanel((columns) => render(state(), columns));
    retime();
  }

  /**
   * Start or stop the one-second repaint, based on whether anything on screen
   * depends on the clock. See the header.
   */
  function retime(): void {
    const needed =
      mode.kind === "approval" ||
      mode.kind === "details" ||
      (mode.kind === "list" && details().length > 0);
    if (needed && !tick) {
      tick = setInterval(() => {
        if (mode.kind === "approval" && now() >= mode.expiresAt) {
          // The countdown reaching zero is an answer, and it is "no". Settling
          // it here rather than waiting for `decideAccess` to time out keeps
          // the screen and the decision in step.
          answer({ approved: false, reason: "timeout" });
          return;
        }
        view.refresh();
      }, 1000);
      tick.unref?.();
    } else if (!needed && tick) {
      clearTimeout(tick);
      tick = null;
    }
  }

  function setFlash(text: string): void {
    flash = text;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash = null;
      paint();
    }, FLASH_MS);
    flashTimer.unref?.();
    paint();
  }

  function clearFlash(): void {
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = null;
    flash = null;
    paint();
  }

  function answer(result: AccessPromptResult): void {
    const resolve = answering;
    answering = null;
    mode = { kind: "list" };
    paint();
    resolve?.(result);
  }

  async function onKey(raw: string): Promise<void> {
    if (stopped) return;
    const key = raw.toLowerCase();

    if (mode.kind === "approval") {
      // Only y and n. Every other key is ignored rather than dismissing the
      // question, because a dismissal the user reads as a refusal but which
      // refuses nothing is the worst thing this surface can do.
      if (key === "y") answer({ approved: true });
      else if (key === "n") answer({ approved: false, reason: "refused" });
      return;
    }

    if (mode.kind === "help") {
      mode = { kind: "list" };
      paint();
      return;
    }

    if (mode.kind === "rename") {
      return onRenameKey(raw, mode);
    }

    if (mode.kind === "details") {
      // The card names its keys in the footer, so those have to work from
      // inside it. Anything else closes, which is what "any other key goes
      // back" promises. All of them act on the row the card is describing
      // rather than on the cursor, which the card can outlive.
      const describing = mode.key;
      const target = rows().find((r) => r.key === describing) ?? null;
      mode = { kind: "list" };
      if (target) cursor = rows().indexOf(target);
      if (key === "c") return doClose();
      if (key === "r" && target?.deviceId) return askRevoke();
      if (key === "e" && target?.deviceId) return openRename();
      paint();
      return;
    }

    if (mode.kind === "confirm") {
      if (key === "y") await doRevoke(mode.deviceId, mode.label);
      else if (key === "n" || raw === KEY.escape) {
        mode = { kind: "list" };
        paint();
      }
      return;
    }

    const list = rows();
    switch (raw) {
      case KEY.up:
        cursor = clamp(cursor - 1, list.length);
        return paint();
      case KEY.down:
        cursor = clamp(cursor + 1, list.length);
        return paint();
    }

    switch (key) {
      case "?":
      case "h":
        mode = { kind: "help" };
        return paint();
      case "q":
        stop();
        return deps.onQuit();
      case "l":
        deps.reprint?.();
        return paint();
      case "n":
        if (!deps.hosted() || !deps.rearm) return;
        deps.rearm();
        return setFlash(kleur.dim("Arming a fresh code…"));
      case "a":
        return toggleAsk();
      case "t":
        return doOpenTunnel();
      case "d":
      case KEY.enter:
        return openDetails();
      case "c":
        return doClose();
      case "e":
        return openRename();
      case "r":
        return askRevoke();
    }
  }

  /**
   * Flip "ask again when a device I know comes back".
   *
   * Live, without a restart, because the setting's whole value is situational:
   * you want it on when you are about to walk away from the machine and off
   * when you are sitting in front of it, and a setting you have to stop the
   * server to change is one nobody ever changes.
   */
  async function toggleAsk(): Promise<void> {
    if (!deps.setAskOnReconnect || !deps.askOnReconnect) return;
    const next = !deps.askOnReconnect();
    await deps.setAskOnReconnect(next).catch(() => {});
    setFlash(
      next
        ? kleur.dim("A device you know will be asked about when it returns.")
        : kleur.dim("A device you know comes straight back in."),
    );
  }

  /**
   * The rename editor's keys.
   *
   * A line editor rather than a readline — see `rename()` in `device-panel.ts`
   * for why. It takes printable characters, backspace, Enter and Esc, and
   * ignores everything else rather than letting an arrow key's escape sequence
   * land in the middle of somebody's device name.
   */
  async function onRenameKey(
    raw: string,
    current: Extract<PanelMode, { kind: "rename" }>,
  ): Promise<void> {
    if (raw === KEY.escape) {
      mode = { kind: "list" };
      return paint();
    }
    if (raw === KEY.enter) {
      const name = current.draft.trim();
      mode = { kind: "list" };
      const ok = await deps
        .rename?.(current.deviceId, name || null)
        .catch(() => false);
      setFlash(
        !ok
          ? kleur.dim("That device is gone — nothing was renamed.")
          : name
            ? kleur.dim(`Renamed to ${name}.`)
            : kleur.dim("Name cleared — back to what the browser calls it."),
      );
      return;
    }
    // Backspace and delete both arrive here, and both mean the same thing to
    // anyone holding the key down.
    if (raw === "\x7f" || raw === "\b") {
      mode = { ...current, draft: [...current.draft].slice(0, -1).join("") };
      return paint();
    }
    // Printable only. A control byte in a device name is a name that cannot be
    // read back off a terminal, and an escape sequence is several of them.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(raw)) return;
    if ([...current.draft].length >= MAX_NAME_INPUT) return;
    mode = { ...current, draft: current.draft + raw };
    paint();
  }

  function openRename(): void {
    const row = selected(state());
    if (!row?.deviceId || !deps.rename) return;
    mode = {
      kind: "rename",
      deviceId: row.deviceId,
      label: row.name,
      // Seeded empty rather than with the current name. The common case is
      // replacing "Chrome on macOS" outright, and pre-filling it would make
      // every rename start with thirteen backspaces.
      draft: "",
    };
    paint();
  }

  /**
   * Turn a local-only server into a reachable one, in place.
   *
   * The alternative this replaces was to stop the server and start it again
   * with `--hosted`, which drops every connected device to change a setting
   * none of them can see. Awaited rather than fired and forgotten, because
   * unlike `n` — which has a printed code to replace when it lands — there is
   * nothing on screen to tell the user this worked except what happens next.
   */
  async function doOpenTunnel(): Promise<void> {
    if (deps.hosted() || !deps.openTunnel || opening) return;
    opening = true;
    setFlash(kleur.dim("Opening an encrypted tunnel…"));
    const failure = await deps.openTunnel().catch((err: unknown) => {
      return err instanceof Error ? err.message : "unknown error";
    });
    opening = false;
    // Success prints its own banner above the panel, which says far more than
    // a flash could — and the "Opening…" line has to go with it, or the panel
    // spends four seconds claiming to still be doing something it has done.
    if (failure) setFlash(kleur.yellow(`Could not open a tunnel: ${failure}`));
    else clearFlash();
  }

  function openDetails(): void {
    const row = selected(state());
    if (!row) return;
    mode = { kind: "details", key: row.key };
    paint();
  }

  async function doClose(): Promise<void> {
    const row = selected(state());
    if (!row?.live?.id || !deps.disconnect) return;
    const closed = await deps.disconnect(row.live.id);
    setFlash(
      closed
        ? kleur.dim(`Closed ${row.name}. It may reconnect.`)
        : kleur.dim(`${row.name} had already gone.`),
    );
  }

  function askRevoke(): void {
    const row = selected(state());
    // No device id means the machine's own token, which has nothing to revoke.
    if (!row?.deviceId || !deps.revoke) return;
    mode = {
      kind: "confirm",
      action: "revoke",
      deviceId: row.deviceId,
      label: row.name,
    };
    paint();
  }

  async function doRevoke(deviceId: string, label: string): Promise<void> {
    mode = { kind: "list" };
    const ok = await deps.revoke?.(deviceId).catch(() => false);
    setFlash(
      ok
        ? kleur.yellow(`Revoked ${label}. It must pair again.`)
        : kleur.dim(`Could not revoke ${label}.`),
    );
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (tick) clearTimeout(tick);
    if (flashTimer) clearTimeout(flashTimer);
    // A question still on screen is abandoned, not answered. `decideAccess`
    // reads `no-tty` as "could not ask", which is the truth once the terminal
    // is going away — and it must not be confusable with a refusal.
    answering?.({ approved: false, reason: "no-tty" });
    answering = null;
    keys.stop();
    unsubscribe?.();
    view.stop();
  }

  keys.setHandler((key) => void onKey(key));
  const unsubscribe = deps.subscribe?.(() => {
    // The list changed under the cursor. Clamping at render is what keeps a
    // device disconnecting while selected from pointing past the end.
    paint();
  });
  paint();

  return {
    enabled: true,
    log: (...lines) => view.log(...lines),
    refresh: paint,
    async promptForAccess(req, signal) {
      if (stopped) return { approved: false, reason: "no-tty" };
      return new Promise<AccessPromptResult>((resolve) => {
        answering = resolve;
        mode = {
          kind: "approval",
          label: req.deviceLabel,
          account: req.accountEmail,
          ...(req.sas ? { sas: req.sas } : {}),
          expiresAt: now() + APPROVAL_WINDOW_MS,
        };
        const onAbort = () => {
          // Answered somewhere else — a phone, `mtmux approve`. Take the
          // question down, and report "could not ask" rather than a refusal.
          if (answering === resolve)
            answer({ approved: false, reason: "no-tty" });
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        paint();
      });
    },
    stop,
  };
}

/**
 * How long the question stands on screen.
 *
 * Matched to `PROMPT_TIMEOUT_MS` in `access-prompt.ts`, and under the broker's
 * 120s request TTL for the same reason that one is: a decision that arrives
 * after the request has expired is worse than no decision, because the human
 * believes they approved something.
 */
const APPROVAL_WINDOW_MS = 110_000;
