import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Integration test for the capture-pane bound.
 *
 * `capture-pane -S -` on a host with a large `history-limit` produces tens of
 * megabytes, which blows past execFile's default 1 MiB `maxBuffer` and REJECTS
 * (it does not truncate). That rejection happened after the old PTY had already
 * been killed, so attaching to any long-lived session left a dead terminal.
 *
 * This builds a throwaway tmux server on a private socket, fills a pane with
 * >1 MiB of scrollback, and asserts the fixture really does reproduce the old
 * failure before checking that `capturePane` stays bounded.
 *
 * tmux-manager reads `config.tmuxSocket` at import time, so the socket is set on
 * process.env before the dynamic import (same pattern as file-service.test.ts).
 */

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const tmuxAvailable = hasTmux();

/**
 * These suites drive a real tmux over `execFile`, several round trips per
 * assertion, against a 12,000-line fixture. Vitest's 5s default is sized for
 * unit tests; on a cold CI runner one `scrollToPosition` clamp test blew
 * through it while doing nothing wrong. The timeout is here to catch a hang,
 * not to police how fast someone else's runner shells out.
 */
const TMUX_TEST_TIMEOUT_MS = 30_000;
const describeTmux = tmuxAvailable ? describe : describe.skip;

const SESSION = "relay-capture-fixture";
const LINE = "x".repeat(120);
const LINE_COUNT = 12_000; // ~1.45 MiB, comfortably over the 1 MiB default
const MARKER = "COLOURED-MARKER";
const ESC = "\u001b"; // SGR sequences start here

let tmux: typeof import("./tmux-manager.js");
let base: string;
let socket: string;
let conf: string;

function tmuxExec(args: string[], maxBuffer = 64 * 1024 * 1024): string {
  return execFileSync("tmux", ["-f", conf, "-S", socket, ...args], {
    encoding: "utf8",
    maxBuffer,
  });
}

beforeAll(async () => {
  if (!tmuxAvailable) return;

  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-tmux-")));
  socket = path.join(base, "sock");

  // Run the fixture as the session's own command rather than send-keys into a
  // shell: no prompt to race, and nothing echoes the script text into the pane
  // (which would make the completion sentinel match before it had run).
  const script = path.join(base, "fixture.sh");
  fs.writeFileSync(
    script,
    [
      `awk 'BEGIN{for(i=0;i<${LINE_COUNT};i++) print "${LINE}"}'`,
      // Coloured sentinel: doubles as the completion marker and the SGR probe.
      `printf '\\033[31m${MARKER}\\033[0m\\n'`,
      // Keep the pane alive so the session doesn't exit out from under us.
      "sleep 600",
    ].join("\n"),
  );

  // history-limit must already be raised when the pane starts producing output,
  // so set it in the config the server boots with rather than after the fact.
  conf = path.join(base, "tmux.conf");
  fs.writeFileSync(conf, "set -g history-limit 200000\n");

  tmuxExec([
    "new-session",
    "-d",
    "-s",
    SESSION,
    "-x",
    "200",
    "-y",
    "50",
    `sh ${script}`,
  ]);

  const deadline = Date.now() + 60_000;
  for (;;) {
    const tail = tmuxExec(["capture-pane", "-t", SESSION, "-p", "-S", "-5"]);
    if (tail.includes(MARKER)) break;
    if (Date.now() > deadline) throw new Error("tmux fixture never finished");
    await new Promise((r) => setTimeout(r, 100));
  }

  process.env.TMUX_SOCKET = socket;
  tmux = await import("./tmux-manager.js");
}, 90_000);

afterAll(() => {
  if (!tmuxAvailable) return;
  try {
    tmuxExec(["kill-server"]);
  } catch {
    // server may already be gone
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describeTmux("capturePane", { timeout: TMUX_TEST_TIMEOUT_MS }, () => {
  it("has a fixture that would overrun the default 1 MiB maxBuffer", () => {
    const full = tmuxExec(["capture-pane", "-t", SESSION, "-p", "-S", "-"]);
    expect(full.length).toBeGreaterThan(1024 * 1024);
  });

  it("returns bounded output instead of throwing", async () => {
    const out = await tmux.capturePane(SESSION);
    expect(out.length).toBeLessThan(1024 * 1024);
    // `-S -2000` means "2000 lines above the visible pane", so the result is
    // the bound plus one pane height — never the full 12k-line history.
    const lines = out.split("\n").length;
    expect(lines).toBeGreaterThan(2000);
    expect(lines).toBeLessThan(LINE_COUNT / 2);
  });

  it("honours an explicit line bound", async () => {
    const bounded = await tmux.capturePane(SESSION, { lines: 10 });
    const dflt = await tmux.capturePane(SESSION);
    expect(bounded.split("\n").length).toBeLessThan(dflt.split("\n").length);
    expect(bounded.split("\n").length).toBeLessThan(200);
  });

  it("keeps SGR escapes by default so colours survive the replay", async () => {
    const out = await tmux.capturePane(SESSION, { lines: 5 });
    expect(out).toContain(MARKER);
    expect(out).toContain(ESC);
  });

  it("can omit escapes for plain-text consumers", async () => {
    const out = await tmux.capturePane(SESSION, { lines: 5, escapes: false });
    expect(out).toContain(MARKER);
    expect(out).not.toContain(ESC);
  });
});

describeTmux("capturePaneById", { timeout: TMUX_TEST_TIMEOUT_MS }, () => {
  it("is bounded and plain-text by default (copy-mode overlay)", async () => {
    const paneId = tmuxExec([
      "list-panes",
      "-t",
      SESSION,
      "-F",
      "#{pane_id}",
    ]).trim();
    const out = await tmux.capturePaneById(paneId);
    expect(out.length).toBeLessThan(1024 * 1024);
    expect(out).not.toContain(ESC);
  });
});

/**
 * Scrolling has to be a tmux operation, not a client one.
 *
 * `attachSession` runs a real `tmux attach-session`, so tmux holds the
 * alternate screen and the browser's own scrollback buffer is always empty —
 * a swipe on a phone had nothing to move, in xterm or in the UA. The history
 * exists only inside tmux, and copy mode is the only door to it, so these run
 * against a real tmux rather than a mock: what is being checked is that the
 * argv actually does what it claims on the tmux that ships.
 */
describeTmux("scrollHistory", { timeout: TMUX_TEST_TIMEOUT_MS }, () => {
  /** Where copy mode is looking, in lines above the live output. */
  function scrollPosition(): number {
    const raw = tmuxExec([
      "display-message",
      "-p",
      "-t",
      SESSION,
      "#{scroll_position}",
    ]).trim();
    return raw === "" ? 0 : parseInt(raw, 10);
  }

  afterEach(async () => {
    await tmux.exitCopyMode(SESSION);
  });

  it("enters copy mode by itself and moves back through history", async () => {
    expect(await tmux.isInCopyMode(SESSION)).toBe(false);
    await tmux.scrollHistory(SESSION, 5);
    expect(await tmux.isInCopyMode(SESSION)).toBe(true);
    expect(scrollPosition()).toBe(5);
  });

  it("accumulates across the several messages one drag produces", async () => {
    await tmux.scrollHistory(SESSION, 5);
    await tmux.scrollHistory(SESSION, 7);
    // Re-entering copy mode on the second call would have reset this to 7.
    expect(scrollPosition()).toBe(12);
  });

  it("scrolls forward again on a negative count", async () => {
    await tmux.scrollHistory(SESSION, 20);
    await tmux.scrollHistory(SESSION, -8);
    expect(scrollPosition()).toBe(12);
  });

  it("clamps at the top of the history rather than failing", async () => {
    await tmux.scrollHistory(SESSION, 500);
    await tmux.scrollHistory(SESSION, 500);
    // Whatever it lands on, it is a number and copy mode is still healthy.
    expect(scrollPosition()).toBeGreaterThan(0);
    expect(await tmux.isInCopyMode(SESSION)).toBe(true);
  });

  it("does nothing at all for a zero count", async () => {
    await tmux.scrollHistory(SESSION, 0);
    expect(await tmux.isInCopyMode(SESSION)).toBe(false);
  });

  it("leaves copy mode on request, so typing works again", async () => {
    await tmux.scrollHistory(SESSION, 10);
    await tmux.exitCopyMode(SESSION);
    expect(await tmux.isInCopyMode(SESSION)).toBe(false);
  });

  it("is a no-op when asked to leave copy mode it is not in", async () => {
    await expect(tmux.exitCopyMode(SESSION)).resolves.toBeUndefined();
  });

  it("returns the position it reached, which is what the scrollbar draws", async () => {
    const state = await tmux.scrollHistory(SESSION, 9);
    expect(state).toMatchObject({ position: 9, inMode: true });
    expect(state.historySize).toBeGreaterThan(0);
    expect(state.paneHeight).toBeGreaterThan(0);
  });

  it("reports a pane outside copy mode as being at the bottom", async () => {
    const state = await tmux.readScrollState(SESSION);
    expect(state.inMode).toBe(false);
    expect(state.position).toBe(0);
    // The history is still there — the view is simply at the live end of it.
    expect(state.historySize).toBeGreaterThan(0);
  });

  it("jumps to an absolute position from anywhere, in either direction", async () => {
    await tmux.scrollToPosition(SESSION, 30);
    expect(scrollPosition()).toBe(30);
    // Down as well as up: a thumb drag names a destination, not a delta.
    await tmux.scrollToPosition(SESSION, 4);
    expect(scrollPosition()).toBe(4);
  });

  it("takes a jump to 0 back to the live output", async () => {
    await tmux.scrollToPosition(SESSION, 25);
    const state = await tmux.scrollToPosition(SESSION, 0);
    // `copy-mode -e` leaves by itself at the bottom, which is the behaviour a
    // scrollbar dragged to the end should have.
    expect(state.position).toBe(0);
    expect(await tmux.isInCopyMode(SESSION)).toBe(false);
  });

  it("clamps a jump past the oldest line to the top of the history", async () => {
    const { historySize } = await tmux.readScrollState(SESSION);
    const state = await tmux.scrollToPosition(SESSION, historySize + 5_000);
    expect(state.position).toBeGreaterThan(0);
    expect(state.position).toBeLessThanOrEqual(historySize);
  });
});

/**
 * The window/pane scoping the mobile switcher depends on.
 *
 * Both `#{pane_active}` and `#{window_zoomed_flag}` are properties of a
 * WINDOW. Read out of an unscoped `list-panes -s` they produce one "active"
 * pane per window and mark every pane of a zoomed window as zoomed — which is
 * exactly what made the browser highlight one window while showing another.
 * These run against a real tmux because the whole claim is about what tmux's
 * format strings actually mean.
 */
describeTmux("windows and panes", { timeout: TMUX_TEST_TIMEOUT_MS }, () => {
  const MULTI = "relay-window-fixture";

  beforeAll(() => {
    tmuxExec(["new-session", "-d", "-s", MULTI, "-x", "200", "-y", "50"]);
    tmuxExec(["new-window", "-t", MULTI]);
    tmuxExec(["new-window", "-t", MULTI]);
    // Split the last window three ways.
    tmuxExec(["split-window", "-t", MULTI]);
    tmuxExec(["split-window", "-t", MULTI]);
  });

  afterAll(() => {
    try {
      tmuxExec(["kill-session", "-t", MULTI]);
    } catch {
      // already gone
    }
  });

  /**
   * Zoom, against real tmux, because the whole point of the change is which
   * tmux command runs in which state — and that is not something a mock can
   * be wrong about in an interesting way.
   *
   * The bug being pinned: `pane:zoom` used to be a bare toggle. Pressing it
   * twice before the layout announcement landed applied twice, so the button
   * showed the opposite of the truth, and it targeted the session's current
   * pane rather than the one tapped.
   */
  describe("zoom", () => {
    /**
     * The split window, found by counting rather than by taking the current
     * one. Two of this fixture's three windows hold a single pane, and tmux
     * will not zoom a window that has nothing to zoom over — so a test that
     * grabbed `listPanes(MULTI)[0]` would be asserting against a window where
     * every zoom command is a silent no-op.
     */
    const splitPanes = async () => {
      const all = await tmux.listPanes(MULTI);
      const counts = new Map<string, number>();
      for (const p of all)
        counts.set(p.windowId, (counts.get(p.windowId) ?? 0) + 1);
      const windowId = [...counts.entries()].find(([, n]) => n > 1)?.[0];
      expect(windowId).toBeDefined();
      return all.filter((p) => p.windowId === windowId);
    };

    const zoomState = async (pane: string) => {
      const panes = await tmux.listPanes(MULTI);
      return panes.find((p) => p.id === pane)?.zoomed ?? false;
    };

    afterEach(async () => {
      // Leave the window unzoomed whatever the test did, so ordering between
      // these cannot matter. By pane id, not by session: the session's current
      // window is not necessarily the one the test just zoomed.
      const panes = await splitPanes();
      // Whichever pane is actually zoomed, if any: asking an unzoomed pane to
      // be unzoomed is correctly a no-op, and would leave the window zoomed.
      const pane = panes.find((p) => p.zoomed) ?? panes[0];
      await tmux.zoomPane(MULTI, { paneId: pane!.id, desired: false });
    });

    it("zooms the pane it was told to, not the one tmux had active", async () => {
      const panes = await splitPanes();
      const inactive = panes.find((p) => !p.active);
      expect(inactive).toBeDefined();

      await tmux.zoomPane(MULTI, { paneId: inactive!.id, desired: true });
      expect(await zoomState(inactive!.id)).toBe(true);
    });

    it("is idempotent, so a double tap does not undo itself", async () => {
      // The actual reported symptom. Two toggles is a no-op; two "make it
      // zoomed" is zoomed.
      const [pane] = await splitPanes();
      await tmux.zoomPane(MULTI, { paneId: pane!.id, desired: true });
      await tmux.zoomPane(MULTI, { paneId: pane!.id, desired: true });
      expect(await zoomState(pane!.id)).toBe(true);
    });

    it("unzooms idempotently too", async () => {
      const [pane] = await splitPanes();
      await tmux.zoomPane(MULTI, { paneId: pane!.id, desired: true });
      await tmux.zoomPane(MULTI, { paneId: pane!.id, desired: false });
      await tmux.zoomPane(MULTI, { paneId: pane!.id, desired: false });
      expect(await zoomState(pane!.id)).toBe(false);
    });

    it("moves the zoom to another pane rather than turning it off", async () => {
      // The case a toggle cannot express: the only thing toggling a zoomed
      // window can do is unzoom it, so asking for B while A is zoomed used to
      // leave nothing zoomed at all.
      const [a, b] = await splitPanes();
      await tmux.zoomPane(MULTI, { paneId: a!.id, desired: true });
      await tmux.zoomPane(MULTI, { paneId: b!.id, desired: true });

      expect(await zoomState(b!.id)).toBe(true);
      expect(await zoomState(a!.id)).toBe(false);
    });

    it("still toggles when no state is asked for, for an older client", async () => {
      const [pane] = await splitPanes();
      await tmux.selectWindow(pane!.windowId);
      await tmux.selectPane(pane!.id);
      const before = await zoomState(pane!.id);
      await tmux.zoomPane(MULTI);
      expect(await zoomState(pane!.id)).toBe(!before);
    });

    /*
     * The window listing has to carry the zoom too, and this is why.
     *
     * `window_layout` is byte-identical zoomed and unzoomed — tmux reports the
     * layout the window will return to — so a change detector built from the
     * layout, the window count and the pane count cannot see a zoom at all.
     * That is what let `prefix z` on the machine leave the browser drawing a
     * pane as zoomed indefinitely: the poll ran, the signature matched, and
     * nothing was announced.
     */
    it("reports zoom on the window, where a layout string cannot", async () => {
      const [pane] = await splitPanes();
      await tmux.zoomPane(MULTI, { paneId: pane!.id, desired: true });
      const zoomedList = await tmux.listWindows(MULTI);
      const zoomedWindow = zoomedList.find((w) => w.id === pane!.windowId);
      expect(zoomedWindow?.zoomed).toBe(true);

      await tmux.zoomPane(MULTI, { paneId: pane!.id, desired: false });
      const flatList = await tmux.listWindows(MULTI);
      const flatWindow = flatList.find((w) => w.id === pane!.windowId);
      expect(flatWindow?.zoomed).toBe(false);

      // The point of the test: the field we used to detect changes by did not
      // move, so only the new one could have told us.
      expect(flatWindow?.layout).toBe(zoomedWindow?.layout);
      expect(flatWindow?.paneCount).toBe(zoomedWindow?.paneCount);
    });

    it("says false for a window with nothing zoomed in it", async () => {
      const windows = await tmux.listWindows(MULTI);
      const single = windows.find((w) => w.paneCount === 1);
      expect(single?.zoomed).toBe(false);
    });
  });

  it("reports the window tmux is actually showing", async () => {
    const windows = await tmux.listWindows(MULTI);
    expect(windows).toHaveLength(3);
    const current = await tmux.currentWindowId(MULTI);
    expect(current).toBe(windows.find((w) => w.active)?.id);
  });

  it("returns exactly one active pane when scoped to a window", async () => {
    const current = await tmux.currentWindowId(MULTI);
    const panes = await tmux.listPanes(MULTI, current);
    expect(panes).toHaveLength(3);
    expect(panes.filter((p) => p.active)).toHaveLength(1);
    expect(panes.every((p) => p.windowId === current)).toBe(true);
  });

  it("returns one active pane PER WINDOW when unscoped — the trap", async () => {
    const all = await tmux.listPanes(MULTI);
    expect(all.length).toBeGreaterThan(3);
    // Three windows, three "active" panes. Anything that does
    // `panes.find(p => p.active)` over this is answering a question about
    // window 1, whatever window is on screen.
    expect(all.filter((p) => p.active)).toHaveLength(3);
  });

  it("marks only the zoomed AND active pane as zoomed", async () => {
    const current = await tmux.currentWindowId(MULTI);
    await tmux.zoomPane(MULTI);
    try {
      const panes = await tmux.listPanes(MULTI, current);
      const zoomed = panes.filter((p) => p.zoomed);
      expect(zoomed).toHaveLength(1);
      expect(zoomed[0]!.active).toBe(true);
    } finally {
      await tmux.zoomPane(MULTI);
    }
  });

  it("steps windows forwards and wraps", async () => {
    const windows = await tmux.listWindows(MULTI);
    const order = windows.map((w) => w.id);
    const start = await tmux.currentWindowId(MULTI);
    const startAt = order.indexOf(start);

    for (let i = 1; i <= order.length; i++) {
      await tmux.stepWindow(MULTI, 1);
      expect(await tmux.currentWindowId(MULTI)).toBe(
        order[(startAt + i) % order.length],
      );
    }
    // A full lap is back where it started.
    expect(await tmux.currentWindowId(MULTI)).toBe(start);
  });

  it("steps windows backwards", async () => {
    const order = (await tmux.listWindows(MULTI)).map((w) => w.id);
    const start = await tmux.currentWindowId(MULTI);
    await tmux.stepWindow(MULTI, -1);
    const back = await tmux.currentWindowId(MULTI);
    expect(back).toBe(
      order[(order.indexOf(start) - 1 + order.length) % order.length],
    );
    await tmux.stepWindow(MULTI, 1);
  });

  it("steps panes inside the current window without leaving it", async () => {
    const current = await tmux.currentWindowId(MULTI);
    const panes = await tmux.listPanes(MULTI, current);
    if (panes.length < 2) return;
    const before = panes.find((p) => p.active)!.id;
    await tmux.stepPane(MULTI, 1);
    const after = await tmux.listPanes(MULTI, current);
    expect(after.find((p) => p.active)!.id).not.toBe(before);
    expect(await tmux.currentWindowId(MULTI)).toBe(current);
  });

  it("keeps the window zoomed across a pane step", async () => {
    const current = await tmux.currentWindowId(MULTI);
    const panes = await tmux.listPanes(MULTI, current);
    if (panes.length < 2) return;
    await tmux.zoomPane(MULTI);
    try {
      const before = (await tmux.listPanes(MULTI, current)).find(
        (p) => p.zoomed,
      )!.id;
      await tmux.stepPane(MULTI, 1);
      const after = await tmux.listPanes(MULTI, current);
      const zoomed = after.filter((p) => p.zoomed);
      // Still zoomed, and zoomed on a DIFFERENT pane — the property the old
      // unzoom/select/rezoom triple kept getting wrong.
      expect(zoomed).toHaveLength(1);
      expect(zoomed[0]!.id).not.toBe(before);
    } finally {
      const stillZoomed = (await tmux.listPanes(MULTI, current)).some(
        (p) => p.zoomed,
      );
      if (stillZoomed) await tmux.zoomPane(MULTI);
    }
  });
});
