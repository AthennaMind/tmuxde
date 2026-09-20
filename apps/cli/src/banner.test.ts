import { describe, it, expect } from "vitest";
import { renderBannerLines, qrLines, type PairingInvite } from "./banner.js";

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
    const lanQrPayload = "http://192.168.1.5:14100/login#n=" + "a".repeat(32);

    it("encodes the LAN sign-in URL instead of an invite", () => {
      const out = render({
        lanUrl: "http://192.168.1.5:14100",
        lanQrPayload,
      }).join("\n");
      expect(out).toContain("Scan to open your terminal");
      expect(out).toMatch(QR_GLYPHS);
    });

    it("says the local path stays local, and does not claim a tunnel", () => {
      const out = render({
        lanUrl: "http://192.168.1.5:14100",
        lanQrPayload,
      }).join("\n");
      expect(out).toContain("On this network only");
      expect(out).not.toContain("Sealed end to end");
    });

    /*
     * The regression this replaces: the banner used to say "No token to type"
     * next to a QR, which is a dead end for any device that cannot scan one.
     */
    it("offers the token beside the QR, not only instead of it", () => {
      expect(
        render({ lanUrl: "http://192.168.1.5:14100", lanQrPayload }).join("\n"),
      ).toContain(TOKEN);
      expect(render({}).join("\n")).toContain(TOKEN);
      expect(render({ lanQrPayload, showQr: false }).join("\n")).toContain(
        TOKEN,
      );
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
      lanQrPayload: "http://192.168.1.5:14100/login#n=" + "a".repeat(32),
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
