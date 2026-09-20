import { describe, expect, it } from "vitest";

import { clamp, render, selected, type PanelState } from "./device-panel.js";
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

function state(over: Partial<PanelState> = {}): PanelState {
  return {
    devices: [device()],
    cursor: 0,
    mode: { kind: "list" },
    flash: null,
    now: NOW,
    hosted: true,
    canOpenTunnel: false,
    frozen: false,
    ...over,
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

  it("says something different when there is no tunnel to scan a code for", () => {
    const out = text(state({ devices: [], hosted: false }));
    expect(out).toContain("on this network");
    expect(out).not.toContain("Scan the code");
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

  it("does not offer to revoke the machine's own token", () => {
    // A browser signed in with the token printed on this screen has no paired
    // device behind it. Offering "revoke" would offer to revoke the machine's
    // own credential, which is not what the word means anywhere else here.
    const out = text(state({ devices: [device({ deviceId: null })] }));
    expect(out).toContain("close");
    expect(out).not.toContain("revoke");
  });

  it("offers a new code only when there is a tunnel", () => {
    expect(text(state({ hosted: true }))).toContain("new code");
    expect(text(state({ hosted: false }))).not.toContain("new code");
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

describe("confirming a revoke", () => {
  it("says it is permanent, and points at the reversible thing instead", () => {
    const out = text(
      state({
        mode: {
          kind: "confirm",
          action: "revoke",
          id: "conn-1",
          label: "iPhone · Safari",
        },
      }),
    );
    expect(out).toContain("Revoke iPhone · Safari?");
    expect(out).toContain("must pair again");
    // The whole reason both verbs exist: someone about to do the permanent
    // thing should be told the temporary one is right there.
    expect(out).toContain("without un-pairing");
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
    const s = state({ devices: [device(), device({ id: "c2" })], cursor: 1 });
    const shrunk = { ...s, devices: [device()] };
    expect(selected(shrunk)?.id).toBe("conn-1");
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

describe("the tunnel key", () => {
  it("offers t instead of n when there is no tunnel yet", () => {
    const out = text(state({ hosted: false, canOpenTunnel: true }));
    expect(out).toContain("tunnel");
    expect(out).not.toContain("new code");
  });

  it("offers n instead of t once the tunnel is up", () => {
    const out = text(state({ hosted: true, canOpenTunnel: false }));
    expect(out).toContain("new code");
    // The two are never both on screen: `n` replaces a code that exists, `t`
    // creates the thing that has codes at all, and a key that cannot work is
    // worse than a key that is absent.
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
        mode: { kind: "details", id: "conn-1" },
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
    expect(out).toContain("this machine's token");
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
      state({ devices: [], mode: { kind: "details", id: "conn-9" } }),
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
            mode: { kind: "details", id: "conn-1" },
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
        mode: { kind: "details", id: "conn-1" },
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
