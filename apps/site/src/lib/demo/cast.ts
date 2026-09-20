import { siteConfig } from "@/config/site";

import { compileCast } from "./player";
import { QR_ROWS } from "./qr-glyph";
import type { Row, Step } from "./types";

/**
 * The home-page transcript.
 *
 * The `mtmux` chapter mirrors what `apps/cli/src/banner.ts` actually prints —
 * the brand line, "Scan to open your terminal", the host and the grouped code,
 * the address block, and "Waiting for a device…   Ctrl+C to stop." A visitor
 * who installs the CLI five minutes later should recognise their own terminal.
 * `player.test.ts` fences the strings that must not drift.
 *
 * The version and the app host come from `siteConfig`, never typed as
 * literals, so a release bump moves them here too.
 */

/**
 * The demo's pairing code — nine digits, grouped the way `codeGroups()` in
 * `@repo/crypto` groups them: a 3-digit slot the broker routes on and a
 * 6-digit secret that never leaves the two endpoints.
 */
const CODE = "492716384";
const GROUPED = "492 716 384";

const INDENT = "  ";

/** Chapter ids. Also the keys the rail's labels are looked up under. */
export const CHAPTERS = [
  "install",
  "pair",
  "approve",
  "attach",
  "move",
  "agent",
] as const;
export type ChapterId = (typeof CHAPTERS)[number];

/**
 * The banner block, laid out two-column exactly like `twoColumn()` in
 * `banner.ts`: the QR on the left, the human-readable fallback beside it.
 */
function bannerRows(): Row[] {
  const aside: Row[] = [
    [],
    [{ text: "Scan to open your terminal", tone: "strong" }],
    [],
    [
      { text: "or go to  ", tone: "faint" },
      { text: siteConfig.appHost, kind: "path" },
    ],
    [
      { text: "and enter ", tone: "faint" },
      { text: GROUPED, kind: "flag" },
    ],
  ];

  return QR_ROWS.map((line, i) => {
    const side = aside[i];
    const left: Row = [{ text: INDENT + line, kind: "qr" }];
    return side ? [...left, { text: "   " }, ...side] : left;
  });
}

const steps: Step[] = [
  // ── 1. Install ──────────────────────────────────────────────────────────
  { k: "mark", chapter: "install" },
  { k: "type", text: `$ ${siteConfig.install}`, ms: 600 },
  { k: "wait", ms: 180 },
  {
    k: "out",
    ms: 420,
    rows: [[], [{ text: "added 1 package in 2s", tone: "faint" }], []],
  },
  { k: "wait", ms: 320 },

  // ── 2. Pair ─────────────────────────────────────────────────────────────
  { k: "mark", chapter: "pair" },
  { k: "type", text: "$ mtmux --hosted", ms: 400 },
  { k: "wait", ms: 180 },
  {
    k: "out",
    ms: 260,
    rows: [
      [],
      [
        { text: INDENT + "›  mtmux", tone: "strong" },
        { text: "  " + siteConfig.version, tone: "faint" },
      ],
    ],
  },
  { k: "out", ms: 320, rows: bannerRows() },
  {
    k: "out",
    ms: 260,
    rows: [
      [],
      [
        { text: INDENT + "Local   ", tone: "faint" },
        { text: "http://127.0.0.1:14100" },
      ],
      [
        { text: INDENT + "Network ", tone: "faint" },
        { text: "http://192.168.1.24:14100" },
        { text: " (en0)", tone: "faint" },
      ],
      [],
      [
        {
          text: INDENT + "Waiting for a device…   Ctrl+C to stop.",
          tone: "faint",
        },
      ],
    ],
  },
  { k: "wait", ms: 1000 },

  // The phone types the code in, one digit at a time, against the banner.
  ...CODE.split("").flatMap<Step>((_, i) => [
    { k: "tap", key: `key-${CODE[i]}`, ms: 130 },
    { k: "phone", patch: { code: CODE.slice(0, i + 1) }, ms: 40 },
  ]),
  { k: "wait", ms: 700 },

  // ── 3. Approve ──────────────────────────────────────────────────────────
  //
  // The beat this demo used to skip, back when the code *was* the approval.
  // Leaving it out now would be showing a product that lets a device in
  // because somebody typed nine digits, which is exactly the behaviour 0.7.1
  // removed. No digits on the question: the code was the shared secret, so
  // there is nothing left to compare.
  { k: "mark", chapter: "approve" },
  {
    k: "out",
    ms: 300,
    rows: [
      [],
      [
        {
          text: INDENT + "A device just entered this machine's pairing code",
          tone: "strong",
        },
      ],
      [
        { text: INDENT + "Device  ", tone: "faint" },
        { text: "Safari on iPhone" },
      ],
    ],
  },
  { k: "wait", ms: 900 },
  {
    k: "out",
    ms: 260,
    rows: [
      [],
      [
        { text: INDENT + "Let it in?", tone: "strong" },
        { text: " [y/N] ", tone: "faint" },
        { text: "y", kind: "keyword" },
      ],
    ],
  },
  { k: "wait", ms: 800 },

  // ── 4. Attach ───────────────────────────────────────────────────────────
  { k: "mark", chapter: "attach" },
  { k: "phone", patch: { paired: true }, ms: 240 },
  {
    k: "out",
    ms: 300,
    rows: [
      [],
      [
        { text: INDENT + "iPhone", kind: "done" },
        { text: " attached  ", tone: "faint" },
        { text: "sealed tunnel", kind: "keyword" },
      ],
    ],
  },
  { k: "swipe", to: "editor", dir: 1, ms: 380 },
  { k: "wait", ms: 1000 },

  // ── 5. Move between windows ─────────────────────────────────────────────
  { k: "mark", chapter: "move" },
  { k: "swipe", to: "server", dir: 1, ms: 360 },
  { k: "wait", ms: 1000 },
  { k: "tap", key: "tab-agent", ms: 200 },
  { k: "swipe", to: "agent", dir: 1, ms: 360 },
  { k: "wait", ms: 900 },
  { k: "swipe", to: "server", dir: -1, ms: 360 },
  { k: "wait", ms: 800 },

  // ── 6. The agent keeps running ──────────────────────────────────────────
  { k: "mark", chapter: "agent" },
  { k: "swipe", to: "agent", dir: 1, ms: 360 },
  {
    k: "out",
    ms: 420,
    rows: [
      [],
      [{ text: INDENT + "Session continues on the machine.", tone: "faint" }],
      [
        { text: INDENT + "Close the tab — ", tone: "faint" },
        { text: "tmux keeps running", kind: "agent" },
        { text: ".", tone: "faint" },
      ],
    ],
  },
  { k: "wait", ms: 1800 },
];

export const HOME_DEMO = compileCast({
  // Sized to the tallest chapter (the banner) so the viewport never reflows.
  // 24, not 22: the nine-digit code is a version-3 QR, four modules taller than
  // the six-digit one, and at 22 the banner scrolled its own `$ mtmux` prompt
  // off the top. `player.test.ts` asserts that prompt is still in the settled
  // frame, which is what caught it.
  rows: 24,
  cols: 66,
  steps,
});

export { CODE, GROUPED };
