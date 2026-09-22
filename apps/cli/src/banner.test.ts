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
describe("a code that has been replaced", () => {
  const plain = (lines: string[]) =>
    lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

  it("says the new code and nothing else", () => {
    const out = plain(
      renderCodeUpdateLines({
        code: "492716384",
        url: "https://app.mtmux.com/j#c=492716384",
        host: "app.mtmux.com",
      }),
    );
    expect(out).toContain("492 716 384");
    expect(out).not.toContain("mtmux");
    expect(out).not.toContain("Waiting");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("offers a fresh QR, because the one above it is now stale", () => {
    const out = plain(
      renderCodeUpdateLines({
        code: "344511",
        url: null,
        host: "x",
        reach: "local",
      }),
    );
    expect(out).toContain("344 511");
    expect(out).toContain("l");
  });

  it("says nothing about a QR when the run has none", () => {
    const out = plain(
      renderCodeUpdateLines(
        { code: "344511", url: null, host: "x", reach: "local" },
        { showQr: false },
      ),
    );
    expect(out).toContain("344 511");
    expect(out).not.toContain("QR");
  });

  it("points at the QR when the typed half is the part that is gone", () => {
    const out = plain(
      renderCodeUpdateLines({ code: null, url: "https://x/j", host: "x" }),
    );
    expect(out).toContain("fresh QR");
  });
});
