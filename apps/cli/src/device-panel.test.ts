import { describe, expect, it } from "vitest";

import {
  buildRows,
  clamp,
  displayName,
  render,
  selected,
  type PanelMode,
  type PanelPeer,
  type PanelState,
} from "./device-panel.js";
import { displayWidth } from "./live-view.js";
import type { ConnectedDevice } from "./serve.js";

/**
 * The panel is pure, so it can be asserted as text.
 *
 * Which matters more than it sounds: a status table's failure mode is not
 * throwing, it is being one column out at a width nobody tried. Everything
 * below strips colour first and asserts on the plain string, because that is
 * what the user reads.
 */

const NOW = 1_700_000_000_000;

function device(over: Partial<ConnectedDevice> = {}): ConnectedDevice {
  return {
    id: "conn-1",
    label: "iPhone · Safari",
    connectedAt: NOW - 120_000,
    readOnly: false,
    lastActivityAt: NOW - 2000,
    attachedSession: "work",
    tokenId: "tok-1",
    deviceId: "dev-1",
    remoteAddress: "192.168.1.5",
    transport: "lan",
    scope: { kind: "all" },
    ...over,
  };
}

function peer(over: Partial<PanelPeer> = {}): PanelPeer {
  return {
    deviceId: "dev-1",
    label: "iPhone · Safari",
    pairedAt: NOW - 86_400_000,
    lastSeenAt: NOW - 3_600_000,
    expired: false,
    ...over,
  };
}

/**
 * Built from `devices` and `peers` rather than taking `rows` directly.
 *
 * The ordering rule — connected first, then everything else this machine
 * trusts — is part of what is being asserted, so the tests go through the same
 * `buildRows` the panel does rather than hand-assembling a list that could be
 * in an order the panel would never produce.
 */
function state(
  over: Partial<Omit<PanelState, "rows">> & {
    devices?: ConnectedDevice[];
    peers?: PanelPeer[];
  } = {},
): PanelState {
  const { devices = [device()], peers = [], ...rest } = over;
  return {
    rows: buildRows(devices, peers),
    cursor: 0,
    mode: { kind: "list" },
    flash: null,
    now: NOW,
    hosted: true,
    canOpenTunnel: false,
    askOnReconnect: false,
    invite: null,
    frozen: false,
    ...rest,
  };
}

/** Colour is noise for these assertions; the layout is the subject. */
const plain = (lines: string[]) =>
  lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
const text = (s: PanelState, width = 90) => plain(render(s, width)).join("\n");

describe("the list", () => {
  it("says who is connected, and where they are", () => {
    const out = text(state());
    expect(out).toContain("1 device connected");
    expect(out).toContain("iPhone · Safari");
    expect(out).toContain("work");
  });

  it("pluralises honestly", () => {
    expect(
      text(state({ devices: [device(), device({ id: "c2" })] })),
    ).toContain("2 devices connected");
  });

  it("tells an empty machine what to do rather than showing an empty table", () => {
    // A header row over nothing reads as a broken table. The useful thing to
    // say when nobody is connected is the next step.
    const out = text(state({ devices: [], hosted: true }));
    expect(out).toContain("Nothing connected");
    expect(out).toContain("Scan the code above");
    expect(out).not.toContain("—");
  });

  it("says the digits themselves once there is a code to say", () => {
    // The banner prints the code once and then the session scrolls. This is
    // the surface that does not, so it carries the one fact somebody needs to
    // get a second device in — and when it does, the vaguer sentence above it
    // is the same instruction with the useful half missing.
    const out = text(
      state({
        devices: [],
        hosted: false,
        invite: { code: "344511", host: "192.168.1.5:14100" },
      }),
    );
    expect(out).toContain("344 511");
    expect(out).toContain("192.168.1.5:14100");
    expect(out).not.toContain("Scan the code above");
  });

  it("keeps the code on screen while devices are connected", () => {
    // Adding a laptop is a thing you do with a phone already attached.
    const out = text(
      state({ invite: { code: "482913756", host: "app.mtmux.com" } }),
    );
    expect(out).toContain("482 913 756");
  });

  it("falls back to the vaguer sentence when there is no code at all", () => {
    const out = text(state({ devices: [], invite: null }));
    expect(out).toContain("Scan the code above");
  });

  it("marks a read-only share as one", () => {
    expect(text(state({ devices: [device({ readOnly: true })] }))).toContain(
      "read-only",
    );
  });

  it("marks a scoped share, and names the session it reaches", () => {
    const out = text(
      state({
        devices: [
          device({
            attachedSession: null,
            scope: { kind: "sessions", sessions: ["work"] },
          }),
        ],
      }),
    );
    expect(out).toContain("shared");
    expect(out).toContain("work");
  });

  it("caps the table and says how many it did not show", () => {
    // Twelve phones on one machine is unusual but a panel that grows without
    // bound pushes the banner and the code off the screen.
    const devices = Array.from({ length: 12 }, (_, i) =>
      device({ id: `c${i}`, label: `Phone ${i}` }),
    );
    const out = text(state({ devices }));
    expect(out).toContain("Phone 0");
    expect(out).not.toContain("Phone 9");
    expect(out).toContain("and 4 more");
  });
});

describe("the key bar", () => {
  it("offers nothing to act on when nothing is connected", () => {
    const out = text(state({ devices: [] }));
    expect(out).not.toContain("close");
    expect(out).not.toContain("revoke");
    expect(out).toContain("quit");
  });

  it("offers select only when there is more than one row", () => {
    expect(text(state())).not.toContain("select");
    expect(
      text(state({ devices: [device(), device({ id: "c2" })] })),
    ).toContain("select");
  });

  it("offers one way to get rid of a row, not two", () => {
    // `c close` and `r revoke` used to sit side by side, which read as a soft
    // and a hard version of the same thing when only one of them lasted.
    const out = text(state());
    expect(out).toContain("r remove");
    expect(out).not.toContain("close");
  });

  it("offers a fresh code beside the code itself, and only with a tunnel", () => {
    // `n` re-arms a broker code. A local offer re-arms itself the moment it is
    // spent, so there would be nothing for the key to do — and it is named
    // next to the digits it replaces rather than as one more pair in the bar.
    const invite = { code: "482913756", host: "app.mtmux.com" };
    expect(text(state({ hosted: true, invite }))).toContain("n for a new one");
    expect(text(state({ hosted: false, invite }))).not.toContain(
      "n for a new one",
    );
  });
});

describe("width", () => {
  it.each([40, 52, 80, 120, 200])("fits in %i columns", (width) => {
    const out = plain(
      render(
        state({
          devices: [
            device({ label: "A very long browser label that goes on and on" }),
          ],
        }),
        width,
      ),
    );
    for (const line of out) {
      expect(displayWidth(line)).toBeLessThanOrEqual(Math.max(40, width));
    }
  });

  it("does not let a wide label shear the columns", () => {
    // A label of CJK is half as many characters as columns. Measured by
    // `.length` the table goes out by exactly that difference.
    const out = plain(
      render(state({ devices: [device({ label: "日本語のブラウザ" })] }), 80),
    );
    for (const line of out) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });
});

describe("the approval question", () => {
  const asking = (sas?: string) =>
    state({
      mode: {
        kind: "approval",
        label: "Safari on iPhone",
        account: "",
        ...(sas ? { sas } : {}),
        expiresAt: NOW + 42_000,
      },
    });

  it("shows the digits to compare when there are digits", () => {
    const out = text(asking("482 173"));
    expect(out).toContain("482 173");
    expect(out).toContain("Deny if they differ");
  });

  it("shows no digit line at all for a code pairing", () => {
    // The nine-digit code was itself the secret, so there is nothing to
    // compare. A blank "Code" row would be asking for a check that cannot fail.
    const out = text(asking());
    expect(out).not.toContain("Code");
    expect(out).toContain("Say yes only if that was you");
  });

  it("says that doing nothing refuses, and how long is left", () => {
    const out = text(asking());
    expect(out).toContain("42s left");
    expect(out).toContain("doing nothing refuses it");
  });

  it("hides the device list while a question is up", () => {
    // Nothing else is reachable until it is answered: a key bar offering
    // "close" beside an unanswered question invites answering it by accident.
    const out = text(asking());
    expect(out).not.toContain("quit");
    expect(out).not.toContain("iPhone · Safari");
  });
});

describe("confirming a removal", () => {
  it("names what coming back will cost", () => {
    const out = text(
      state({
        mode: {
          kind: "confirm",
          action: "remove",
          deviceId: "dev-1",
          connectionId: "conn-1",
          label: "iPhone · Safari",
        },
      }),
    );
    expect(out).toContain("Remove iPhone · Safari?");
    expect(out).toContain("new code and your approval");
  });

  it("promises only a hang-up for a row with nothing to forget", () => {
    // Overstating this one would be the worse error: the reader would believe
    // a device was gone when it holds the machine's own token and can return
    // at will.
    const out = text(
      state({
        mode: {
          kind: "confirm",
          action: "disconnect",
          deviceId: null,
          connectionId: "conn-1",
          label: "iPhone",
        },
      }),
    );
    expect(out).toContain("Disconnect iPhone?");
    expect(out).toContain("come straight back");
    expect(out).not.toContain("pair again");
  });
});

describe("the cursor", () => {
  it("never points outside the list", () => {
    expect(clamp(9, 2)).toBe(1);
    expect(clamp(-3, 2)).toBe(0);
    expect(clamp(0, 0)).toBe(0);
  });

  it("resolves to nothing when the list is empty", () => {
    expect(selected(state({ devices: [], cursor: 3 }))).toBeNull();
  });

  it("survives the list shrinking under it", () => {
    // A device disconnecting while the cursor is on the last row is ordinary,
    // and an out-of-range index would render a row of `undefined`.
    const s = state({
      devices: [device(), device({ id: "c2", deviceId: "dev-2" })],
      cursor: 1,
    });
    const shrunk = { ...s, rows: buildRows([device()], []) };
    expect(selected(shrunk)?.live?.id).toBe("conn-1");
    expect(() => render(shrunk, 80)).not.toThrow();
  });
});

describe("liveness", () => {
  it("calls a connection with recent traffic live rather than a number", () => {
    // A counter ticking every second draws the eye to a connection doing
    // nothing interesting.
    expect(text(state())).toContain("live");
  });

  it("says how long a quiet connection has been quiet", () => {
    const out = text(
      state({ devices: [device({ lastActivityAt: NOW - 600_000 })] }),
    );
    expect(out).toContain("idle 10m");
  });

  it("leaves the column blank against a relay that does not report activity", () => {
    // An older bundle has no `lastActivityAt`. Showing "idle 55y" from a
    // missing field would be worse than showing nothing.
    const { lastActivityAt: _drop, ...rest } = device();
    const out = text(state({ devices: [rest] }));
    expect(out).not.toContain("idle");
    expect(out).toContain("iPhone · Safari");
  });
});

describe("the tunnel offer", () => {
  /*
   * `t` in the key bar is two characters among six other pairs — invisible to
   * anyone who has not already been told what it does, which is everyone. The
   * thing on offer is the product's headline feature in one keypress.
   */
  it("spells out what t does, rather than leaving it as a letter", () => {
    const out = text(state({ hosted: false, canOpenTunnel: true }));
    expect(out).toContain("reach it from anywhere");
    expect(out).toContain("sealed end to end");
  });

  it("shortens rather than truncating on a narrow terminal", () => {
    for (const width of [40, 52, 64, 80, 120]) {
      const lines = plain(
        render(state({ hosted: false, canOpenTunnel: true }), width),
      );
      const offer = lines.find((l) => l.includes("Press t"))!;
      expect(displayWidth(offer)).toBeLessThanOrEqual(width);
      // Never half a sentence: the last words are the ones worth reading.
      expect(offer.trimEnd().endsWith(".")).toBe(true);
    }
  });

  it("says nothing once there is a tunnel", () => {
    expect(text(state({ hosted: true, canOpenTunnel: false }))).not.toContain(
      "Press t",
    );
  });

  it("gets out of the way of a flash, which is the same row", () => {
    const out = text(
      state({ hosted: false, canOpenTunnel: true, flash: "Opening…" }),
    );
    expect(out).toContain("Opening…");
    expect(out).not.toContain("Press t");
  });
});

describe("the tunnel key", () => {
  it("offers the tunnel as a sentence rather than as a key", () => {
    // `t` is the product's headline feature and it was two characters in a
    // row of seven pairs. The offer above the bar says what it does; putting
    // the letter in the bar as well is the same key twice.
    const out = text(state({ hosted: false, canOpenTunnel: true }));
    expect(out).toContain("Press t");
    expect(out).not.toContain("new code");
    expect(out).not.toMatch(/\bt tunnel\b/);
  });

  it("stops offering the tunnel once it is up", () => {
    // `t` creates the thing that has codes at all; once it exists the offer is
    // a key that cannot work, which is worse than a key that is absent.
    const out = text(state({ hosted: true, canOpenTunnel: false }));
    expect(out).not.toContain("Press t");
    expect(out).not.toMatch(/\bt tunnel\b/);
  });

  it("offers neither when nothing can open one", () => {
    const out = text(state({ hosted: false, canOpenTunnel: false }));
    expect(out).not.toContain("tunnel");
    expect(out).not.toContain("new code");
  });
});

describe("the detail card", () => {
  const open = (over: Partial<ConnectedDevice> = {}, width = 90) =>
    text(
      state({
        devices: [device(over)],
        // `null` means "whatever the cursor is on", which is the one row
        // there is. Naming a key here would make every variation of this
        // helper have to know how `buildRows` chose it.
        mode: { kind: "details", key: null },
      }),
      width,
    );

  it("says everything the row had no room for", () => {
    const out = open({ size: { cols: 120, rows: 40 } });
    expect(out).toContain("iPhone · Safari");
    expect(out).toContain("2m ago");
    expect(out).toContain("work");
    expect(out).toContain("120×40");
    expect(out).toContain("over this network from 192.168.1.5");
    expect(out).toContain("dev-1");
    expect(out).toContain("conn-1");
  });

  it("spells out what the grant allows", () => {
    expect(open()).toContain("every session");
    expect(open({ readOnly: true })).toContain("watch only");
    expect(open({ files: "write" })).toContain("read and write files");
    expect(open({ scope: { kind: "sessions", sessions: ["work"] } })).toContain(
      "only work",
    );
  });

  it("names the machine's own token rather than an absent device", () => {
    const out = open({ deviceId: null });
    expect(out).toContain("this machine's own token");
    // Nothing to revoke, so nothing offers to.
    expect(out).not.toContain("r revoke");
  });

  /*
   * The card is keyed on the connection id, so a device that drops while it is
   * open must say so — silently redrawing as whichever device slid into that
   * row would be the panel lying about what the next keypress acts on.
   */
  it("admits when the connection it describes has gone", () => {
    const out = text(
      state({ devices: [], mode: { kind: "details", key: "nope" } }),
    );
    expect(out).toContain("has gone");
  });

  it("omits a field rather than printing a dash", () => {
    const out = open({ attachedSession: null, size: null });
    expect(out).not.toContain("Session");
    expect(out).not.toContain("Screen");
  });

  it("never overflows a narrow terminal", () => {
    for (const width of [40, 64, 90]) {
      for (const line of plain(
        render(
          state({
            devices: [device({ label: "📱".repeat(30) })],
            mode: { kind: "details", key: "dev-1" },
          }),
          width,
        ),
      )) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("where a connection came from", () => {
  const from = (over: Partial<ConnectedDevice>) =>
    text(
      state({
        devices: [device(over)],
        mode: { kind: "details", key: "dev-1" },
      }),
    );

  /*
   * The case this field exists for. A tunnelled device and a browser on this
   * machine are both loopback; guessing from the address would tell the reader
   * the opposite of the truth about the one they care about.
   */
  it("names the tunnel, which no address could", () => {
    expect(from({ transport: "tunnel", remoteAddress: "127.0.0.1" })).toContain(
      "through the encrypted tunnel",
    );
    expect(
      from({ transport: "loopback", remoteAddress: "127.0.0.1" }),
    ).toContain("from this machine");
  });

  it("falls back to the bare address against an older relay", () => {
    const out = from({
      transport: undefined,
      remoteAddress: "::ffff:10.0.0.9",
    });
    expect(out).toContain("10.0.0.9");
    expect(out).not.toContain("network");
  });
});

/**
 * Connected is not the same as paired, and the list has to hold both.
 *
 * The panel used to show live sockets only, which made it useless for the
 * most common thing anyone wants to do to a device: get rid of one that is
 * not here.
 */
describe("devices that are paired but not connected", () => {
  it("lists them under the connected ones", () => {
    const rows = buildRows(
      [device()],
      [peer(), peer({ deviceId: "dev-2", label: "Old iPad" })],
    );
    expect(rows.map((r) => r.key)).toEqual(["dev-1", "dev-2"]);
    expect(rows[0]!.live).not.toBeNull();
    expect(rows[1]!.live).toBeNull();
  });

  it("does not list a connected device twice", () => {
    const rows = buildRows([device()], [peer()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.peer).not.toBeNull();
  });

  it("puts the most recently seen first among the absent", () => {
    const rows = buildRows(
      [],
      [
        peer({ deviceId: "old", lastSeenAt: NOW - 90_000_000 }),
        peer({ deviceId: "recent", lastSeenAt: NOW - 1000 }),
      ],
    );
    expect(rows.map((r) => r.key)).toEqual(["recent", "old"]);
  });

  it("says how many are paired but absent, and when each was last here", () => {
    const out = text(
      state({
        devices: [device()],
        peers: [peer(), peer({ deviceId: "dev-2", label: "Old iPad" })],
      }),
    );
    expect(out).toContain("1 paired, not here");
    expect(out).toContain("paired, not connected");
    expect(out).toContain("Old iPad");
    expect(out).toContain("1h");
  });

  it("calls a long-idle one stale rather than printing a number", () => {
    const out = text(
      state({
        devices: [],
        peers: [peer({ deviceId: "dev-2", expired: true })],
      }),
    );
    expect(out).toContain("stale");
  });

  it("can still be removed, with nothing to hang up", () => {
    const out = text(
      state({ devices: [], peers: [peer({ deviceId: "dev-2" })] }),
    );
    expect(out).toContain("r remove");
    expect(out).not.toContain("close");
  });

  it("says plainly that it is not here, rather than faking a connection", () => {
    const out = plain(
      render(
        state({
          devices: [],
          peers: [peer({ deviceId: "dev-2" })],
          mode: { kind: "details", key: "dev-2" },
        }),
        90,
      ),
    ).join("\n");
    expect(out).toContain("not right now");
    expect(out).toContain("Last seen");
    expect(out).toContain("Paired");
  });
});

/**
 * Three rows reading "Chrome on macOS" is a list you cannot act on. The name
 * is for the reader; it changes nothing about what the device may do.
 */
describe("names", () => {
  it("prefers what the owner called it over what the browser did", () => {
    const rows = buildRows([device()], [peer({ name: "Work laptop" })]);
    expect(rows[0]!.name).toBe("Work laptop");
    expect(text(state({ peers: [peer({ name: "Work laptop" })] }))).toContain(
      "Work laptop",
    );
  });

  it("falls back to the browser's label, including a name of only spaces", () => {
    expect(buildRows([device()], [peer({ name: "   " })])[0]!.name).toBe(
      "iPhone · Safari",
    );
  });

  it("keeps the browser's own claim visible on the card", () => {
    // The one field that can contradict a name, and therefore the one worth
    // keeping when it does.
    const out = plain(
      render(
        state({
          peers: [peer({ name: "Work laptop" })],
          mode: { kind: "details", key: "dev-1" },
        }),
        90,
      ),
    ).join("\n");
    expect(out).toContain("Work laptop");
    expect(out).toContain("Browser");
    expect(out).toContain("iPhone · Safari");
  });

  it("does not repeat the label when there is no rename", () => {
    const out = plain(
      render(
        state({ peers: [peer()], mode: { kind: "details", key: "dev-1" } }),
        90,
      ),
    ).join("\n");
    expect(out).not.toContain("Browser");
  });

  it("draws an editor that says how to clear the name", () => {
    const out = plain(
      render(
        state({
          mode: {
            kind: "rename",
            deviceId: "dev-1",
            label: "iPhone · Safari",
            draft: "Work",
          },
        }),
        90,
      ),
    ).join("\n");
    expect(out).toContain("Rename");
    expect(out).toContain("Work");
    expect(out).toContain("empty clears it");
    expect(out).toContain("Esc cancels");
  });

  it("never overflows while a long name is being typed", () => {
    for (const width of [40, 52, 80]) {
      const lines = plain(
        render(
          state({
            mode: {
              kind: "rename",
              deviceId: "dev-1",
              label: "📱".repeat(30),
              draft: "x".repeat(32),
            },
          }),
          width,
        ),
      );
      for (const line of lines)
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

/**
 * "It never asked me" is almost always this setting, doing exactly what it was
 * told. A setting nobody can see is a setting nobody can be wrong about.
 */
describe("the reconnect policy", () => {
  it("says which way it is set, in help", () => {
    const on = plain(
      render(state({ mode: { kind: "help" }, askOnReconnect: true }), 90),
    ).join("\n");
    const off = plain(
      render(state({ mode: { kind: "help" }, askOnReconnect: false }), 90),
    ).join("\n");
    expect(on).toContain("you know is on");
    expect(off).toContain("you know is off");
  });

  /*
   * The setting is about *repeat* questions, not about whether there is one.
   * Every connection is gated now — see `connection-gate.ts` — and a help
   * screen that says otherwise is the one place somebody would go to find out.
   */
  it("says every connection is asked about, whichever way it is set", () => {
    const out = plain(
      render(state({ mode: { kind: "help" }, askOnReconnect: false }), 90),
    ).join("\n");
    expect(out).toContain("Every connection is asked about");
  });

  it("never overflows", () => {
    for (const width of [40, 52, 80, 120]) {
      for (const line of plain(
        render(state({ mode: { kind: "help" } }), width),
      )) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

/**
 * A device label is whatever a peer claimed to be, and it is drawn onto
 * somebody's terminal beside a security question. `sanitizeLabel`'s header
 * makes the argument; these are the render sites it names.
 */
describe("hostile labels", () => {
  const NASTY = "\x1b[2AEvil\x1b[0m‮oops";

  it("strips escapes out of the list", () => {
    const out = text(state({ devices: [device({ label: NASTY })] }));
    expect(out).not.toContain("\x1b[2A");
    expect(out).not.toContain("‮");
    expect(out).toContain("Evil");
  });

  it("strips them out of the approval question, which is the one that matters", () => {
    const out = plain(
      render(
        state({
          mode: {
            kind: "approval",
            label: NASTY,
            account: "\x1b[1Aroot@example.com",
            expiresAt: NOW + 60_000,
          },
        }),
        90,
      ),
    ).join("\n");
    expect(out).not.toContain("\x1b[2A");
    expect(out).not.toContain("\x1b[1A");
    expect(out).toContain("Evil");
  });

  it("strips them out of the revoke confirmation and the rename editor", () => {
    for (const mode of [
      {
        kind: "confirm" as const,
        action: "revoke" as const,
        deviceId: "d",
        label: NASTY,
      },
      { kind: "rename" as const, deviceId: "d", label: NASTY, draft: "" },
    ]) {
      const out = plain(render(state({ mode }), 90)).join("\n");
      expect(out).not.toContain("\x1b[2A");
      expect(out).not.toContain("‮");
    }
  });

  it("strips them out of a stored name as well as a claimed label", () => {
    // The owner's own name cannot be hostile by construction. The rule
    // "nothing reaches the terminal unstripped" is worth more than the
    // exception is worth saving.
    expect(displayName({ name: NASTY, label: "x" })).not.toContain("\x1b");
  });
});

/**
 * The summary row, which was the one line in this panel nobody measured.
 *
 * At 56 columns it ran off the edge, the terminal wrapped it, and every row
 * below shifted down by one — so the panel's own rule ended up orphaned above
 * a line that was not supposed to exist.
 */
describe("the headline", () => {
  /** One line, stripped — `plain` above takes the whole frame. */
  const bare = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

  const wide = (over = {}) =>
    state({
      devices: [device()],
      peers: [peer({ deviceId: "d9" }), peer({ deviceId: "d8" })],
      hosted: true,
      ...over,
    });

  it("fits, and drops whole facts rather than halves of them", () => {
    const line = bare(render(wide(), 40)[1]!);
    expect(line.length).toBeLessThanOrEqual(40);
    // Whatever survived is a complete phrase, never a truncation.
    expect(line).not.toContain("…");
    expect(line).toContain("1 device connected");
  });

  it("keeps the most important facts when it has to choose", () => {
    // Who is here beats how many are not, which beats how they got here.
    const narrow = bare(render(wide(), 46)[1]!);
    expect(narrow).toContain("paired, not here");
    expect(narrow).not.toContain("tunnel up");
  });

  it("says when a device it knows will be asked about, and only then", () => {
    // Off is the default, and a line permanently announcing a default is the
    // noise that teaches people to stop reading a panel.
    expect(bare(render(wide({ askOnReconnect: true }), 120)[1]!)).toContain(
      "asks on return",
    );
    expect(
      bare(render(wide({ askOnReconnect: false }), 120)[1]!),
    ).not.toContain("asks on return");
  });
});

/**
 * Nothing this panel draws may be wider than the terminal it is drawn in.
 *
 * A line that overflows wraps, every row below it shifts by one, and the
 * panel's own accounting of how many rows it occupies goes wrong — so the next
 * repaint erases the wrong part of the screen. The approval screen was doing
 * exactly this at 64 columns: its answer line was 68 wide, which means on a
 * narrow terminal the one line telling a human how to say no was the line that
 * wrapped off the bottom.
 *
 * Swept rather than asserted one screen at a time, because the defect is not
 * in any particular sentence — it is in forgetting to measure a new one.
 */
describe("every mode, at every width", () => {
  const NOW_LOCAL = NOW;
  const modes: PanelMode[] = [
    { kind: "list" },
    { kind: "help" },
    { kind: "details", key: "dev-1" },
    { kind: "details", key: "gone" },
    {
      kind: "confirm",
      action: "remove",
      deviceId: "dev-1",
      connectionId: "c1",
      label: "A rather long device name from a browser",
    },
    {
      kind: "confirm",
      action: "disconnect",
      deviceId: null,
      connectionId: "c1",
      label: "A rather long device name from a browser",
    },
    {
      kind: "confirm",
      action: "remove-all",
      deviceId: null,
      connectionId: null,
      label: "",
      count: 12,
    },
    {
      kind: "rename",
      deviceId: "dev-1",
      label: "A rather long device name from a browser",
      draft: "something being typed right now, quite long",
    },
    {
      kind: "approval",
      label: "Safari on an iPhone with a very long user agent string",
      account: "somebody-with-a-long-address@example.com",
      expiresAt: NOW_LOCAL + 97_000,
    },
    {
      kind: "approval",
      label: "Safari on iPhone",
      account: "dp@example.com",
      sas: "419 082",
      expiresAt: NOW_LOCAL + 97_000,
    },
    {
      kind: "approval",
      label: "Safari on an iPhone with a very long user agent string",
      account: "",
      via: "returning",
      transport: "tunnel",
      expiresAt: NOW_LOCAL + 97_000,
    },
  ];

  for (const width of [40, 56, 64, 80, 120]) {
    for (const mode of modes) {
      const name =
        mode.kind === "confirm" || mode.kind === "approval"
          ? `${mode.kind}/${"action" in mode ? mode.action : mode.sas ? "sas" : "code"}`
          : mode.kind;
      it(`${name} fits ${width} columns`, () => {
        const lines = plain(
          render(
            state({
              mode,
              hosted: true,
              askOnReconnect: true,
              invite: { code: "482913756", host: "app.mtmux.com" },
              peers: [peer({ deviceId: "d9" })],
            }),
            width,
          ),
        );
        for (const line of lines) {
          expect([line.length, line]).toEqual([
            Math.min(line.length, width),
            line,
          ]);
        }
      });
    }
  }
});

/**
 * One browser, two tabs — one pairing, two sockets, one device id.
 *
 * Both rows used to take that id as their key, so every lookup by key matched
 * the first: `d` on the second tab described the first, and anything acting on
 * "the row the card is describing" acted on the wrong socket.
 */
describe("two connections from one device", () => {
  const rows = () =>
    buildRows(
      [
        device({ id: "conn-a", deviceId: "dev-1" }),
        device({ id: "conn-b", deviceId: "dev-1", attachedSession: "logs" }),
      ],
      [peer({ deviceId: "dev-1" })],
    );

  it("gives them different keys", () => {
    const [a, b] = rows();
    expect(a!.key).not.toBe(b!.key);
  });

  it("keeps the plain device id on the first, so an open card survives", () => {
    // A card left open while the device reconnects has to find it again, and
    // the row it comes back as is the one holding the unadorned id.
    expect(rows()[0]!.key).toBe("dev-1");
  });

  it("still points both at the same device for anything that acts on it", () => {
    for (const row of rows()) expect(row.deviceId).toBe("dev-1");
  });

  it("finds each row by its own key", () => {
    const list = rows();
    for (const row of list) {
      expect(list.filter((r) => r.key === row.key)).toHaveLength(1);
    }
  });
});

/**
 * Clearing the list, which is one question rather than N.
 *
 * The act somebody reaches for after handing a laptop back, selling a phone,
 * or seeing a row they cannot account for. Doing it with `r` eight times is
 * seven chances to slip and a lot of reasons not to bother — and the eighth
 * answer is reflex, which is the opposite of what a destructive confirmation
 * is for.
 */
describe("removing every device at once", () => {
  const confirmAll = (count: number, width = 90) =>
    text(
      state({
        mode: {
          kind: "confirm",
          action: "remove-all",
          deviceId: null,
          connectionId: null,
          label: "",
          count,
        },
      }),
      width,
    );

  it("says how many, because 'all' is where somebody can be surprised", () => {
    expect(confirmAll(7)).toContain("all 7 devices");
  });

  it("counts one device as one", () => {
    expect(confirmAll(1)).toContain("all 1 device?");
  });

  it("says what it costs, and what it does not touch", () => {
    const out = confirmAll(4);
    expect(out).toContain("needs a new code");
    // The fear this answers: "will this kill the sessions I am running?"
    expect(out).toContain("keep running");
  });

  it("offers the key only once there is more than one thing to clear", () => {
    const one = text(state({ devices: [device()], peers: [] }));
    const two = text(
      state({
        devices: [device()],
        peers: [peer({ deviceId: "dev-2", label: "iPad" })],
      }),
    );
    expect(one).not.toContain("clear all");
    expect(two).toContain("clear all");
  });
});

/**
 * What the tunnel is doing, rather than only whether it is up.
 *
 * `hosted` is a boolean and a tunnel is not: it spends real seconds
 * registering at boot and real minutes retrying after a broker restart. During
 * both of those the panel said nothing at all, so the honest reading of the
 * screen was "this machine is local-only" — which was false, and about to be
 * visibly false the moment a code appeared.
 */
describe("the tunnel's status", () => {
  it("says it is up when it is up", () => {
    expect(text(state({ hosted: true }))).toContain("tunnel up");
  });

  it("says it is still connecting, rather than nothing at all", () => {
    const out = text(state({ hosted: false, tunnel: "connecting" }));
    expect(out).toContain("tunnel connecting");
    expect(out).not.toContain("tunnel up");
  });

  it("says a tunnel that dropped is being retried", () => {
    expect(text(state({ hosted: false, tunnel: "retrying" }))).toContain(
      "retrying",
    );
  });

  it("says nothing on a run that has no tunnel in its future", () => {
    const out = text(state({ hosted: false }));
    expect(out).not.toContain("tunnel");
  });
});

/**
 * Where a connection is arriving from, on the screen that decides it.
 *
 * The one fact a self-reported label cannot carry, and the one most likely to
 * change the answer: a phone in your pocket does not arrive over the tunnel
 * from a network you have never been on.
 */
describe("the approval question names where it came from", () => {
  const ask = (over: Partial<Extract<PanelMode, { kind: "approval" }>>) =>
    text(
      state({
        mode: {
          kind: "approval",
          label: "iPhone · Safari",
          account: "",
          expiresAt: NOW + 90_000,
          ...over,
        },
      }),
    );

  it("says when it is coming over the tunnel", () => {
    expect(ask({ transport: "tunnel" })).toContain("over the tunnel");
  });

  it("says when it is only this network", () => {
    expect(ask({ transport: "lan" })).toContain("from this network");
  });

  it("asks a known device the question that fits it", () => {
    const out = ask({ via: "returning", transport: "tunnel" });
    expect(out).toContain("A device you know is connecting");
    expect(out).toContain("Say no if you are not the one");
  });

  it("still asks a first-time device the pairing question", () => {
    const out = ask({});
    expect(out).toContain("A device wants in");
    expect(out).not.toContain("Coming");
  });
});
