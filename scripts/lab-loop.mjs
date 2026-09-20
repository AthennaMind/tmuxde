#!/usr/bin/env node
/**
 * The lab's gate: run the sweep, rank what it found, and refuse a regression.
 *
 *   node scripts/lab-loop.mjs            reset, sweep, compare, report
 *   node scripts/lab-loop.mjs --no-reset keep whatever state the lab is in
 *   node scripts/lab-loop.mjs --accept   write what was found as the new floor
 *
 * ## Why this is a script and not an assertion inside the sweep
 *
 * `sweep.spec.ts` says it plainly: it is an instrument, not a gate. A spec
 * that failed at the first stop with a problem would come back with one
 * finding out of however many exist, and the whole value of a sweep is the
 * full list, ranked. So the spec reports and passes, and the comparison
 * happens here, once, across every project's report.
 *
 * ## The ratchet
 *
 * `apps/web/e2e/lab/ratchet.json` is the accepted count per detector per
 * device. A count above it fails. A count below it is not a failure — it is
 * the point — but it is printed, because a floor left above the truth is a
 * regression nobody will notice until it eats the slack. `--accept` lowers it.
 *
 * Raising the ratchet is possible and is meant to be awkward: edit the file by
 * hand, in a commit, with a reason. `--accept` will lower a number and will
 * refuse to raise one, so the easy path is only ever the improving one.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = path.join(ROOT, "apps/web/lab-report");
const RATCHET = path.join(ROOT, "apps/web/e2e/lab/ratchet.json");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

/** Severities worth ranking by, worst first. */
const ORDER = ["blocker", "major", "minor"];

function readRatchet() {
  if (!existsSync(RATCHET)) return {};
  return JSON.parse(readFileSync(RATCHET, "utf8"));
}

/**
 * Findings collapsed to `device → detector → count`.
 *
 * The detector, not the finding id. An id carries the element it was seen on,
 * so a button that moves produces a new id for the same defect and the ratchet
 * would read it as one fixed and one introduced. The detector is stable.
 */
function countsFor(report) {
  const counts = {};
  for (const finding of report.findings) {
    counts[finding.detector] = (counts[finding.detector] ?? 0) + 1;
  }
  return counts;
}

function readReports() {
  if (!existsSync(REPORT_DIR)) return [];
  return readdirSync(REPORT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(REPORT_DIR, f), "utf8")))
    .sort((a, b) => a.device.localeCompare(b.device));
}

async function runSweep() {
  const passthrough = ["--", "e2e/lab/sweep.spec.ts"];
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "scripts/lab.mjs"), "test", ...passthrough],
    { cwd: ROOT, stdio: "inherit" },
  );
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0) {
    throw new Error(
      `the sweep itself failed (exit ${code}) — that is a broken harness or a ` +
        "crashed renderer, not a finding. Nothing was compared.",
    );
  }
}

async function reset() {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "scripts/lab.mjs"), "reset"],
    { cwd: ROOT, stdio: "inherit" },
  );
  await new Promise((resolve) => child.on("exit", resolve));
}

function summarise(reports, ratchet) {
  const lines = ["# Lab sweep", "", `Run at ${new Date().toISOString()}.`, ""];
  const rises = [];
  const falls = [];

  for (const report of reports) {
    const accepted = ratchet[report.device] ?? {};
    const counts = countsFor(report);
    const detectors = [
      ...new Set([...Object.keys(counts), ...Object.keys(accepted)]),
    ].sort();

    lines.push(`## ${report.device}`, "");
    if (report.findings.length === 0 && detectors.length === 0) {
      lines.push("Clean.", "");
    }

    for (const detector of detectors) {
      const now = counts[detector] ?? 0;
      const floor = accepted[detector] ?? 0;
      if (now > floor)
        rises.push({ device: report.device, detector, now, floor });
      if (now < floor)
        falls.push({ device: report.device, detector, now, floor });
      lines.push(
        `- \`${detector}\`: ${now} (accepted ${floor})` +
          (now > floor ? " — **rose**" : now < floor ? " — fell" : ""),
      );
    }
    if (detectors.length > 0) lines.push("");

    const ranked = [...report.findings].sort(
      (a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity),
    );
    for (const finding of ranked) {
      lines.push(
        `- **${finding.severity}** \`${finding.id}\` ×${finding.occurrences}`,
        `  - ${finding.detail.replace(/\n/g, "\n    ")}`,
        `  - seen at: ${finding.seenAt.join(", ") || "—"}`,
      );
    }
    if (ranked.length > 0) lines.push("");
  }

  return { markdown: lines.join("\n") + "\n", rises, falls };
}

function accept(reports, ratchet) {
  const next = { ...ratchet };
  for (const report of reports) {
    const counts = countsFor(report);
    const accepted = { ...(ratchet[report.device] ?? {}) };
    for (const [detector, floor] of Object.entries(accepted)) {
      const now = counts[detector] ?? 0;
      // Only ever downwards. A rise has to be argued for in a commit.
      if (now < floor) accepted[detector] = now;
      if (accepted[detector] === 0) delete accepted[detector];
    }
    next[report.device] = accepted;
  }
  writeFileSync(RATCHET, JSON.stringify(next, null, 2) + "\n");
  return next;
}

if (!has("--no-reset")) await reset();
await runSweep();

const reports = readReports();
if (reports.length === 0) {
  process.stderr.write(
    `no reports in ${path.relative(ROOT, REPORT_DIR)} — the sweep wrote nothing\n`,
  );
  process.exit(1);
}

const ratchet = readRatchet();
const { markdown, rises, falls } = summarise(reports, ratchet);
writeFileSync(path.join(REPORT_DIR, "summary.md"), markdown);

process.stdout.write("\n" + markdown);
process.stdout.write(
  `written: ${path.relative(ROOT, path.join(REPORT_DIR, "summary.md"))}\n`,
);

if (has("--accept")) {
  accept(reports, ratchet);
  process.stdout.write(`ratchet lowered: ${path.relative(ROOT, RATCHET)}\n`);
}

for (const fall of falls) {
  process.stdout.write(
    `fell: ${fall.device}/${fall.detector} ${fall.floor} → ${fall.now}` +
      " — lower the ratchet (`--accept`) so it cannot come back\n",
  );
}

if (rises.length > 0) {
  process.stderr.write("\n");
  for (const rise of rises) {
    process.stderr.write(
      `rose: ${rise.device}/${rise.detector} ${rise.floor} → ${rise.now}\n`,
    );
  }
  process.stderr.write(
    "\nthe ratchet only goes down. Fix the finding, or raise the floor by " +
      "hand with a reason.\n",
  );
  process.exit(1);
}

process.stdout.write("\nratchet held.\n");
