#!/usr/bin/env node
/**
 * Regenerates `.github/assets/demo.svg` — the README's "Demo" section.
 *
 * What this replaced was a fenced code block containing five rows of
 * half-block glyphs standing in for a QR. It encoded nothing: a real mtmux
 * banner QR is sixteen rows of half-blocks, so the README was showing a
 * scannable-looking thing that no scanner has ever read.
 *
 * The fix is not "paste in the real sixteen rows". Half-blocks pack two
 * modules into one character cell, so the code is only square when the line
 * height is close to the character width — true in a terminal, false in a
 * GitHub `<pre>`, which sets 1.45. At that leading the modules come out ~20%
 * taller than wide and the code stops resolving. `apps/site` hit this exact
 * wall and answered it the same way: draw unit squares on a grid
 * (`primitives/qr-code.tsx`), and let nothing about the render depend on the
 * reader's font.
 *
 * So the demo is an image, drawn from the same encoder the CLI uses, and its
 * QR leads to `https://mtmux.com` rather than to an example pairing code that
 * was never live — same reasoning as `build-banner.mjs`.
 *
 * The terminal half is the banner `renderBannerLines()` in
 * `apps/cli/src/banner.ts` actually prints, in its order: brand line, QR
 * beside the typed fallback, address block, then the waiting line. The phone
 * half is the `serve` window from the home page's demo cast
 * (`apps/site/src/components/demo/phone-frame.tsx`), so the two places we show
 * this product agree with each other.
 *
 * Run: node .github/assets/build-demo.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../apps/cli/"));
const QRCode = require("qrcode-terminal/vendor/QRCode");
const ErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

const QR_TARGET = "https://mtmux.com";
/** The digits the banner prints beside the code. An example, and labelled one. */
const EXAMPLE_CODE = "492 716 384";
/**
 * Read, not transcribed.
 *
 * This used to be a literal with a comment asking whoever bumped the CLI to
 * remember this file too. Nobody did — it said 0.6.3 through two minor
 * releases, so the README's hero image advertised a version npm had not served
 * for weeks. A constant that must be kept in step with a file three
 * directories away is a constant that will drift; read the file.
 */
const VERSION = JSON.parse(
  readFileSync(path.join(here, "../../apps/cli/package.json"), "utf8"),
).version;

const MONO =
  "ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace";
const SANS =
  "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'DejaVu Sans',sans-serif";

const INK = "#0b0a09";
const PAPER = "#f3ede8";
const ACCENT = "#e87958";
const DIM = "#7d6f66";
const MID = "#a2938a";
const OK = "#8fb573";
const LINK = "#7fa8c9";

/* ── the QR ───────────────────────────────────────────────────────────── */

const qr = new QRCode(-1, ErrorCorrectLevel.M);
qr.addData(QR_TARGET);
qr.make();
const modules = qr.getModuleCount();
const QUIET = 4;
// 8px modules, not 5. GitHub lays a README image out at roughly 820 CSS px, so
// a 1280-wide drawing is shown at ~0.64 scale — at 5px a module reached the
// reader as 3.2px and OpenCV stopped decoding the render somewhere above 900px
// wide. At 8px it survives well past the size GitHub actually serves.
const MODULE_PX = 8;
const PLAQUE = (modules + QUIET * 2) * MODULE_PX;
const QR_AT = { x: 96, y: 232 };

let cells = "";
for (let row = 0; row < modules; row++) {
  for (let col = 0; col < modules; col++) {
    if (!qr.isDark(row, col)) continue;
    cells +=
      `<rect x="${QR_AT.x + (col + QUIET) * MODULE_PX}"` +
      ` y="${QR_AT.y + (row + QUIET) * MODULE_PX}"` +
      ` width="${MODULE_PX}" height="${MODULE_PX}"/>`;
  }
}

/* ── the phone ────────────────────────────────────────────────────────── */

const PHONE = { x: 892, y: 214, w: 308, h: 462 };

/** The `serve` window, verbatim from the site's demo. */
const PANE = [
  ["$ pnpm dev", ACCENT],
  ["", DIM],
  ["ready on :14100", OK],
  ["GET  /api/health  200", MID],
  ["GET  /api/session 200", MID],
  ["POST /api/pair    201", MID],
  ["", DIM],
  ["watching…", DIM],
];

const TABS = [
  ["1", "edit", false],
  ["2", "serve", true],
  ["3", "agent", false],
];

let tabs = "";
let tabX = PHONE.x + 14;
for (const [index, name, active] of TABS) {
  const label = `${index} ${name}`;
  const w = label.length * 7.6 + 14;
  tabs +=
    `<rect x="${tabX}" y="${PHONE.y + 62}" width="${w.toFixed(1)}" height="22" rx="5" fill="${
      active ? ACCENT : "#1c1815"
    }"/>` +
    `<text x="${(tabX + w / 2).toFixed(1)}" y="${PHONE.y + 77}" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${
      active ? INK : DIM
    }">${label}</text>`;
  tabX += w + 7;
}

const paneLines = PANE.map(
  ([text, fill], i) =>
    `<text x="${PHONE.x + 16}" y="${PHONE.y + 118 + i * 22}" font-family="${MONO}" font-size="13" fill="${fill}">${text}</text>`,
).join("");

/* ── the page ─────────────────────────────────────────────────────────── */

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="900" viewBox="0 0 1280 900" role="img" aria-label="A terminal running mtmux beside a phone browser: the terminal prints a QR and a nine-digit pairing code, asks whether to let the device in, and the phone is attached to the same tmux session, showing the dev server window">
  <title>mtmux — one command in the terminal, the same tmux session on a phone</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#12100f"/><stop offset="1" stop-color="#1c1815"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0"/>
      <stop offset="0.5" stop-color="${ACCENT}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="1280" height="900" fill="url(#bg)"/>
  <rect x="0" y="0" width="1280" height="2" fill="url(#glow)"/>

  <!-- ── the machine ── -->
  <rect x="64" y="76" width="700" height="728" rx="14" fill="${INK}" stroke="#332c27" stroke-width="1.5"/>
  <path d="M64 90a14 14 0 0 1 14-14h672a14 14 0 0 1 14 14v28H64z" fill="#191512"/>
  <circle cx="92" cy="97" r="5.5" fill="#4a403a"/>
  <circle cx="112" cy="97" r="5.5" fill="#4a403a"/>
  <circle cx="132" cy="97" r="5.5" fill="#4a403a"/>
  <text x="414" y="102" text-anchor="middle" font-family="${MONO}" font-size="13" fill="${DIM}">mbp — mtmux</text>

  <g font-family="${MONO}" font-size="17">
    <text x="96" y="158" fill="${DIM}">$</text>
    <text x="118" y="158" fill="${PAPER}">mtmux --hosted</text>
    <text x="96" y="204" fill="${ACCENT}">&#8250;</text>
    <text x="122" y="204" fill="${PAPER}">mtmux</text>
    <text x="196" y="204" fill="${DIM}">${VERSION}</text>
  </g>

  <rect x="${QR_AT.x}" y="${QR_AT.y}" width="${PLAQUE}" height="${PLAQUE}" fill="${PAPER}"/>
  <g fill="${INK}">${cells}</g>

  <!--
    Label and value on separate lines, never a <tspan> after text in the same
    <text>. A bare tspan is positioned by the advance of what precedes it, and
    that advance is whatever font the renderer happened to find — browsers get
    it right, ImageMagick and several thumbnailers stack the two on top of each
    other. Every string here starts at its own x, so nothing can overlap.
  -->
  <g font-family="${MONO}">
    <text x="380" y="300" font-size="16" fill="${PAPER}">Scan to open your terminal</text>
    <text x="380" y="348" font-size="16" fill="${DIM}">or go to</text>
    <text x="380" y="378" font-size="18" fill="${ACCENT}">app.mtmux.com</text>
    <text x="380" y="424" font-size="16" fill="${DIM}">and enter</text>
    <text x="380" y="456" font-size="22" fill="${PAPER}">${EXAMPLE_CODE}</text>
    <text x="380" y="484" font-size="12.5" fill="${DIM}">example only — yours is printed fresh each run</text>
  </g>

  <g font-family="${MONO}" font-size="16">
    <text x="96" y="552" fill="${DIM}">Local</text>
    <text x="184" y="552" fill="${PAPER}">http://127.0.0.1:14100</text>
    <text x="96" y="580" fill="${DIM}">Network</text>
    <text x="184" y="580" fill="${PAPER}">http://192.168.1.24:14100</text>
    <text x="464" y="580" fill="${DIM}">(en0)</text>
    <text x="96" y="624" fill="${DIM}">Waiting for a device…   Ctrl+C to stop.</text>
  </g>

  <!--
    The gate, which is the part of this flow a picture is most likely to leave
    out and the part that most changes what the product *is*. Entering the code
    does not let a device in; a human does. Showing "Waiting…" and then
    "attached" with nothing between them would be advertising the behaviour
    this release deliberately stopped having.

    No six digits on this line, and that is the honest rendering: the code the
    browser typed was the shared secret, so there is nothing left to compare.
  -->
  <g font-family="${MONO}" font-size="16">
    <text x="96" y="672" fill="${PAPER}">A device just entered this machine&#8217;s pairing code</text>
    <text x="96" y="702" fill="${DIM}">Device</text>
    <text x="184" y="702" fill="${PAPER}">Safari on iPhone</text>
    <text x="96" y="732" fill="${PAPER}">Let it in?</text>
    <text x="188" y="732" fill="${MID}">[y/N]</text>
    <text x="242" y="732" fill="${ACCENT}">y</text>
  </g>

  <g font-family="${MONO}" font-size="16">
    <text x="96" y="772" fill="${OK}">iPhone attached</text>
    <text x="280" y="772" fill="${LINK}">sealed tunnel</text>
  </g>

  <!-- ── the phone ── -->
  <rect x="${PHONE.x - 10}" y="${PHONE.y - 10}" width="${PHONE.w + 20}" height="${PHONE.h + 20}" rx="34" fill="#191512" stroke="#332c27" stroke-width="1.5"/>
  <rect x="${PHONE.x}" y="${PHONE.y}" width="${PHONE.w}" height="${PHONE.h}" rx="24" fill="${INK}" stroke="#2a2521" stroke-width="1"/>
  <circle cx="${PHONE.x + 18}" cy="${PHONE.y + 26}" r="4" fill="${OK}"/>
  <text x="${PHONE.x + 32}" y="${PHONE.y + 31}" font-family="${MONO}" font-size="13" fill="${MID}">app.mtmux.com</text>
  <line x1="${PHONE.x}" y1="${PHONE.y + 46}" x2="${PHONE.x + PHONE.w}" y2="${PHONE.y + 46}" stroke="#2a2521"/>
  ${tabs}
  ${paneLines}
  <line x1="${PHONE.x}" y1="${PHONE.y + 316}" x2="${PHONE.x + PHONE.w}" y2="${PHONE.y + 316}" stroke="#2a2521"/>
  <g font-family="${MONO}" font-size="12" fill="${DIM}">
    <text x="${PHONE.x + 16}" y="${PHONE.y + 338}">2 · serve  ·  swipe to move</text>
  </g>
  <g font-family="${MONO}" font-size="13">
    ${["esc", "ctrl", "tab", "↑", "↓"]
      .map((key, i) => {
        const w = 52;
        const x = PHONE.x + 12 + i * (w + 6);
        return (
          `<rect x="${x}" y="${PHONE.y + 358}" width="${w}" height="34" rx="7" fill="#1c1815" stroke="#332c27"/>` +
          `<text x="${x + w / 2}" y="${PHONE.y + 380}" text-anchor="middle" fill="${MID}">${key}</text>`
        );
      })
      .join("")}
  </g>
  <text x="${PHONE.x + PHONE.w / 2}" y="${PHONE.y + 428}" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${DIM}">same tmux server · no SSH key here</text>

  <text x="640" y="862" text-anchor="middle" font-family="${SANS}" font-size="22" fill="${MID}">One command on the machine. Scan the code, say yes, and the phone is on the same tmux server.</text>
</svg>
`;

const out = path.join(here, "demo.svg");
writeFileSync(out, svg);
console.log(
  `wrote ${out} — QR ${modules}×${modules} @ ${MODULE_PX}px, quiet ${QUIET}, ${QR_TARGET}`,
);
