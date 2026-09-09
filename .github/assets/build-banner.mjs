#!/usr/bin/env node
/**
 * Regenerates `.github/assets/banner.svg`.
 *
 * The QR is drawn as a grid of `<rect>`, never as text glyphs: GitHub serves
 * this file to a browser that has no idea what fonts we had, and a QR made of
 * block characters becomes noise the moment one of them falls back.
 *
 * Two rules the previous hand-authored version broke, both of which are the
 * difference between a picture of a QR and a QR:
 *
 *   1. The quiet zone is four modules, not two. The spec asks for four, and
 *      this one sits on a near-black panel, so a thin margin is exactly where
 *      a scanner gives up.
 *   2. It encodes a URL that is still there tomorrow. It used to carry
 *      `https://app.mtmux.com/j#492716384` — the example code printed beside
 *      it, which was never a live pairing. Anyone who scanned the README got
 *      a dead code, which is a worse first impression than no QR at all.
 *
 * Run: node .github/assets/build-banner.mjs
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../apps/cli/"),
);
const QRCode = require("qrcode-terminal/vendor/QRCode");
const ErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

/** Where a reader who scans the README actually lands. */
const QR_TARGET = "https://mtmux.com";
/** The digits printed beside it. An illustration, and labelled as one. */
const EXAMPLE_CODE = "492 716 384";

const MONO =
  "ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace";
const SANS =
  "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'DejaVu Sans',sans-serif";

const INK = "#0b0a09";
const PAPER = "#f3ede8";
const ACCENT = "#e87958";
const DIM = "#7d6f66";
const MID = "#a2938a";

// M, not L: this image gets resized by every README reader's browser and
// screenshotted by some of them, and the extra redundancy is free here —
// 17 bytes still fits in version 2.
const qr = new QRCode(-1, ErrorCorrectLevel.M);
qr.addData(QR_TARGET);
qr.make();

const modules = qr.getModuleCount();
const QUIET = 4;
const PANEL = { x: 162, y: 262, size: 231 };
const scale = PANEL.size / (modules + QUIET * 2);
if (!Number.isInteger(scale)) {
  // A fractional module lands on half a pixel and blurs the edge a scanner
  // is trying to threshold. Resize the panel rather than accept it.
  throw new Error(
    `panel ${PANEL.size}px does not divide into ${modules + QUIET * 2} modules`,
  );
}

let cells = "";
for (let row = 0; row < modules; row++) {
  for (let col = 0; col < modules; col++) {
    if (!qr.isDark(row, col)) continue;
    const x = PANEL.x + (col + QUIET) * scale;
    const y = PANEL.y + (row + QUIET) * scale;
    cells += `<rect x="${x}" y="${y}" width="${scale}" height="${scale}"/>`;
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-label="mtmux — run one command, scan the code, and your phone is on your machine's tmux">
  <title>mtmux — your tmux, in any browser</title>
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

  <rect width="1280" height="640" fill="url(#bg)"/>
  <rect x="0" y="0" width="1280" height="2" fill="url(#glow)"/>

  <rect x="96" y="88" width="1088" height="478" rx="14" fill="${INK}" stroke="#332c27" stroke-width="1.5"/>
  <path d="M96 102a14 14 0 0 1 14-14h1060a14 14 0 0 1 14 14v30H96z" fill="#191512"/>
  <circle cx="126" cy="110" r="6" fill="#4a403a"/>
  <circle cx="148" cy="110" r="6" fill="#4a403a"/>
  <circle cx="170" cy="110" r="6" fill="#4a403a"/>
  <text x="640" y="115" text-anchor="middle" font-family="${MONO}" font-size="15" fill="${DIM}">mtmux</text>

  <g font-family="${MONO}" font-size="21">
    <text x="162" y="186" fill="${DIM}">$</text>
    <text x="188" y="186" fill="${PAPER}">npm install -g mtmux &amp;&amp; mtmux</text>
    <text x="162" y="232" fill="${ACCENT}">&#8250;</text>
    <text x="188" y="232" fill="${PAPER}">serving your tmux on one port</text>
  </g>

  <rect x="${PANEL.x}" y="${PANEL.y}" width="${PANEL.size}" height="${PANEL.size}" fill="${PAPER}"/>
  <g fill="${INK}">${cells}</g>

  <g font-family="${MONO}">
    <text x="449" y="296" font-size="19" fill="${MID}">Scan to open your terminal</text>
    <text x="449" y="352" font-size="19" fill="${DIM}">or go to</text>
    <text x="449" y="382" font-size="21" fill="${PAPER}">app.mtmux.com</text>
    <text x="449" y="430" font-size="19" fill="${DIM}">and enter</text>
    <text x="449" y="466" font-size="30" fill="${ACCENT}">${EXAMPLE_CODE}</text>
    <text x="449" y="492" font-size="15" fill="${DIM}">example only — yours is printed fresh each run</text>
  </g>

  <g font-family="${MONO}" font-size="18">
    <text x="162" y="538" fill="${DIM}">Waiting for a device...</text>
    <text x="449" y="538" fill="${DIM}">Ctrl+C to stop.</text>
  </g>

  <text x="640" y="612" text-anchor="middle" font-family="${SANS}" font-size="24" fill="${MID}">Your tmux, in any browser — one command, no port forward, no SSH key on the phone.</text>
</svg>
`;

const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "banner.svg",
);
writeFileSync(out, svg);
console.log(
  `wrote ${out} — QR ${modules}×${modules} @ ${scale}px, quiet ${QUIET}, ${QR_TARGET}`,
);
