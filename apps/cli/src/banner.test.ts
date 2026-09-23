import { describe, it, expect } from "vitest";
import {
  renderBannerLines,
  renderCodeUpdateLines,
  qrLines,
  type BannerOpts,
  type PairingInvite,
} from "./banner.js";

const TOKEN = "a".repeat(64);

const INVITE: PairingInvite = {
  code: "482913756",
  url: "https://app.mtmux.com/j#482913756",
  host: "app.mtmux.com",
};

function render(overrides: Partial<Parameters<typeof renderBannerLines>[0]>) {
  return renderBannerLines({
    version: "0.4.0",
    localUrl: "http://localhost:14100",
    token: TOKEN,
    columns: 120,
    ...overrides,
  });
}

const QR_GLYPHS = /[█▀▄]/;

describe("renderBannerLines", () => {
  it("always shows the loopback URL", () => {
    const out = render({}).join("\n");
    expect(out).toContain("Local");
    expect(out).toContain("http://localhost:14100");
  });

  it("omits the network row when there is no LAN URL", () => {
    expect(render({ lanUrl: null }).join("\n")).not.toContain("Network");
  });

  it("prints the real LAN URL and its interface — never '0.0.0.0'", () => {
    const out = render({
      lanUrl: "http://192.168.1.5:14100",
      lanInterface: "wlp3s0",
    }).join("\n");
    expect(out).toContain("Network");
    expect(out).toContain("http://192.168.1.5:14100");
    expect(out).toContain("(wlp3s0)");
    expect(out).not.toContain("0.0.0.0");
  });

  describe("with a hosted invite", () => {
    it("shows the code grouped, the host, and a QR", () => {
      const out = render({ invite: INVITE }).join("\n");
      expect(out).toContain("482 913 756");
      expect(out).toContain("app.mtmux.com");
      expect(out).toMatch(QR_GLYPHS);
    });

    it("still shows the code when the QR is suppressed", () => {
      const out = render({ invite: INVITE, showQr: false });
      expect(out.join("\n")).toContain("482 913 756");
      expect(out.join("\n")).not.toMatch(QR_GLYPHS);
    });

    // Nine digits that expire beat a permanent 64-character secret, and
    // printing both invites the wrong one to be copied.
    it("does not print the token", () => {
      expect(render({ invite: INVITE }).join("\n")).not.toContain(TOKEN);
    });

    it("says it is waiting for a device", () => {
      expect(render({ invite: INVITE }).join("\n")).toContain("Waiting");
    });

    it("says the tunnel is sealed, because that is the whole product", () => {
      expect(render({ invite: INVITE }).join("\n")).toContain(
        "Sealed end to end",
      );
    });
  });

  describe("local mode", () => {
    const LOCAL: PairingInvite = {
      code: "483921",
      url: "http://192.168.1.5:14100/login#n=" + "a".repeat(32),
      host: "192.168.1.5:14100",
      reach: "local",
    };
    const local = (extra: Partial<BannerOpts> = {}) =>
      render({ lanUrl: "http://192.168.1.5:14100", invite: LOCAL, ...extra });

    it("encodes the sign-in URL as a QR", () => {
      const out = local().join("\n");
      expect(out).toContain("Scan to open your terminal");
      expect(out).toMatch(QR_GLYPHS);
    });

    /*
     * The gap this closes: local mode used to print a QR, an address and a
     * 64-character token, and nothing a person could type. "I cannot scan
     * that" had no answer short of copying a hex string off a screen.
     */
    it("prints six digits to type, grouped", () => {
      const out = local().join("\n");
      expect(out).toContain("483 921");
      expect(out).toContain("192.168.1.5:14100");
    });

    it("still prints the digits with the QR turned off", () => {
      const out = local({ showQr: false }).join("\n");
      expect(out).toContain("483 921");
      expect(out).not.toMatch(QR_GLYPHS);
    });

    it("says the local path stays local, and does not claim a tunnel", () => {
      const out = local().join("\n");
      expect(out).toContain("On this network only");
      expect(out).not.toContain("Sealed end to end");
    });

    it("does not group six digits the way it groups nine", () => {
      // `483 921`, not `483 921 ` — the two formats are different and the
      // banner is where a reader sees which one they are holding.
      expect(local().join("\n")).not.toContain("483 921 ");
    });

    /*
     * The token is demoted now that there is a code, by the same rule the
     * hosted banner follows: a short credential that expires beats a permanent
     * 64-character secret, and printing both invites the wrong one to be
     * copied. It is still there for a run that has no code at all.
     */
    it("demotes the token once there is a code, and keeps it when there is none", () => {
      expect(local().join("\n")).not.toContain(TOKEN);
      expect(render({}).join("\n")).toContain(TOKEN);
    });
  });

  it("surfaces a degradation note", () => {
    const out = render({ note: "Tunnel unavailable. Serving locally." });
    expect(out.join("\n")).toContain("Tunnel unavailable");
  });

  it("places the QR beside the text on a wide terminal", () => {
    const out = render({ invite: INVITE, columns: 120 });
    const aside = out.find((l) => l.includes("Scan to open"))!;
    expect(aside).toMatch(QR_GLYPHS);
  });

  it("stacks the QR above the text when the terminal is narrow", () => {
    const out = render({ invite: INVITE, columns: 40 });
    const aside = out.find((l) => l.includes("Scan to open"))!;
    expect(aside).not.toMatch(QR_GLYPHS);
    // …but the QR is still rendered, just on its own rows.
    expect(out.some((l) => QR_GLYPHS.test(l))).toBe(true);
  });

  it("never lets a line exceed the terminal width", () => {
    const columns = 100;
    const out = render({
      lanUrl: "http://192.168.1.5:14100",
      lanInterface: "wlp3s0",
      invite: INVITE,
      columns,
    });
    for (const line of out) {
      expect([...line.replace(/\[[0-9;]*m/g, "")].length).toBeLessThanOrEqual(
        columns,
      );
    }
  });
  /*
   * The aside beside the QR is hand-wrapped, so it is the one thing here that
   * a wording change can silently break: one long line pushes `twoColumn` into
   * its stacked layout, and the banner quietly stops being two columns on a
   * terminal wide enough for both.
   */
  it("keeps the QR beside the text in every mode a wide terminal has", () => {
    const local = render({
      lanUrl: "http://192.168.1.5:14100",
      invite: {
        code: "483921",
        url: "http://192.168.1.5:14100/login#n=" + "a".repeat(32),
        host: "192.168.1.5:14100",
        reach: "local",
      },
      columns: 100,
    });
    expect(local.find((l) => l.includes("On this network only"))).toMatch(
      QR_GLYPHS,
    );
    expect(
      render({ invite: INVITE, columns: 100 }).find((l) =>
        l.includes("Sealed end to end"),
      ),
    ).toMatch(QR_GLYPHS);
  });
});

describe("qrLines", () => {
  it("produces a square-ish block of QR rows with no blank lines", () => {
    const lines = qrLines("http://192.168.1.5:14100/login#n=" + "a".repeat(32));
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.every((l) => l.trim().length > 0)).toBe(true);
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
  });
});

/**
 * The re-arm, which used to be the whole banner again.
 *
 * Every pairing spends the printed code, and the old answer was to redraw the
 * version header, the QR, both addresses and the promise to say that nine
 * digits had changed. Three phones later the terminal held four near-identical
 * blocks and the reader had to diff two QRs to find the line that moved.
 */
/**
 * The re-arm, which is the pairing block again and nothing else.
 *
 * Every pairing spends the code *and* the QR on screen. For a while the answer
 * was one line of digits with "press l for a fresh QR" on the end — the right
 * amount of ink and the wrong behaviour, because the QR still sitting above it
 * was a dead credential drawn in full colour and the live one was behind a
 * keybinding nobody had been told about. So the block comes back whole, and
 * the rest of the banner — version, addresses, the promise — does not.
 */
describe("a code that has been replaced", () => {
  const plain = (lines: string[]) =>
    lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

  const QR_GLYPHS_RE = /[█▀▄]/;

  it("redraws the code and a live QR, without redrawing the banner", () => {
    const out = plain(
      renderCodeUpdateLines(
        {
          code: "492716384",
          url: "https://app.mtmux.com/j#c=492716384",
          host: "app.mtmux.com",
        },
        { columns: 100 },
      ),
    );
    expect(out).toContain("492 716 384");
    expect(out).toMatch(QR_GLYPHS_RE);
    expect(out).toContain("app.mtmux.com");
    // The parts of the banner that did not change stay where they are.
    expect(out).not.toContain("Waiting");
    expect(out).not.toContain("Local");
  });

  it("says the one above it is dead, because it is still on screen", () => {
    const out = plain(
      renderCodeUpdateLines(
        {
          code: "344511",
          url: "http://x/login#n=y",
          host: "x",
          reach: "local",
        },
        { columns: 100 },
      ),
    );
    expect(out).toContain("344 511");
    expect(out).toContain("dead");
    // A local code is local, and a re-arm is not where that stops being true.
    expect(out).toContain("On this network only.");
  });

  it("falls back to the digits alone when there is no QR to draw", () => {
    const out = plain(
      renderCodeUpdateLines(
        { code: "344511", url: null, host: "x", reach: "local" },
        { showQr: false },
      ),
    );
    expect(out).toContain("344 511");
    expect(out).not.toMatch(QR_GLYPHS_RE);
  });

  it("still draws the QR when the typed half is the part that is gone", () => {
    const out = plain(
      renderCodeUpdateLines(
        { code: null, url: "https://x/j", host: "x" },
        { columns: 100 },
      ),
    );
    expect(out).toMatch(QR_GLYPHS_RE);
    expect(out).toContain("New code");
  });
});

/**
 * Local mode's way out, printed where the need for it appears.
 *
 * "On this network only" is the sentence that makes somebody decide this
 * product is not for them. An offer two paragraphs below it arrives after that
 * decision has already been made.
 */
describe("the tunnel offer beside the code", () => {
  const LOCAL: PairingInvite = {
    code: "344511",
    url: "http://192.168.1.5:14100/login#n=x",
    host: "192.168.1.5:14100",
    reach: "local",
  };

  it("sits under the limitation it answers", () => {
    const out = render({
      invite: LOCAL,
      lanUrl: "http://192.168.1.5:14100",
      canOpenTunnel: true,
    }).join("\n");
    const limitation = out.indexOf("On this network only");
    const offer = out.indexOf("to reach it from");
    expect(limitation).toBeGreaterThan(-1);
    expect(offer).toBeGreaterThan(limitation);
    expect(out).toContain("Press ");
  });

  it("is absent when there is no tunnel to open", () => {
    // `--local` is a decision already made, and a key that does nothing is
    // worse than no key at all.
    const out = render({ invite: LOCAL, canOpenTunnel: false }).join("\n");
    expect(out).toContain("On this network only");
    expect(out).not.toContain("to reach it from");
  });

  it("never appears on a hosted banner, which has no such limitation", () => {
    const out = render({ invite: INVITE, canOpenTunnel: true }).join("\n");
    expect(out).not.toContain("to reach it from");
    expect(out).toContain("Sealed end to end");
  });
});

/**
 * One address, said once.
 *
 * In local mode the code block already names the best address there is, and
 * the block below it printed the same thing again with a label on — two lines
 * the reader has to compare character by character to find out they are the
 * same place.
 */
describe("the address block", () => {
  const LOCAL: PairingInvite = {
    code: "344511",
    url: "http://192.168.1.5:14100/login#n=x",
    host: "192.168.1.5:14100",
    reach: "local",
  };

  it("drops the row the code block has already named", () => {
    const out = render({
      invite: LOCAL,
      lanUrl: "http://192.168.1.5:14100",
      lanInterface: "wlp3s0",
    }).join("\n");
    expect(out).toContain("192.168.1.5:14100");
    expect(out).not.toContain("Network");
    // The one that is genuinely new information stays.
    expect(out).toContain("Local");
    expect(out).toContain("http://localhost:14100");
  });

  it("never renders empty, even when the invite names the only address", () => {
    const out = render({
      invite: { ...LOCAL, host: "localhost:14100" },
      lanUrl: null,
    }).join("\n");
    expect(out).toContain("Local");
    expect(out).toContain("http://localhost:14100");
  });

  it("keeps both rows for a hosted invite, which names neither", () => {
    const out = render({
      invite: INVITE,
      lanUrl: "http://192.168.1.5:14100",
    }).join("\n");
    expect(out).toContain("Local");
    expect(out).toContain("Network");
  });
});
