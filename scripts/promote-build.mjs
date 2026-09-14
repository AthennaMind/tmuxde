#!/usr/bin/env node
/**
 * Promote a finished build into the directory the production process serves.
 *
 * Every Next app here builds into `.next-build` and serves out of
 * `.next-serve` (see each app's `next.config.ts`). The two are deliberately
 * different directories: `next build` clears its dist directory before
 * emitting into it, so building into the tree a running server is reading
 * strands that server with a half-build it cannot require from.
 *
 * That is not hypothetical. On 2026-09-09 a build did it to the marketing
 * site — `.next` lost BUILD_ID, every top-level manifest and all of
 * server/chunks, and /pricing and /agents threw ChunkLoadError while routes
 * already resident in memory kept answering 200 and hid the damage. The
 * comments in scripts/deploy-hosted.mjs record the same failure on apps/web,
 * where a replaced tree left workers 404ing their own chunks.
 *
 * This script is the explicit hand-off between the two directories. The
 * outgoing tree is kept as `.next-prev` so a bad promote can be rolled back
 * without rebuilding; only one generation is kept.
 *
 * Usage: node scripts/promote-build.mjs <apps/site|apps/docs|apps/web> [--no-reload]
 */
import { execFileSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");

/**
 * `standalone` is about how the process is started, not about what
 * next.config.ts says. apps/docs sets output: "standalone" but PM2 runs
 * `next start` against it, so it is promoted like a normal build; apps/web is
 * the only one PM2 boots by standalone server path.
 */
const APPS = {
  "apps/site": { pm2: "mtmux-web", standalone: false },
  "apps/docs": { pm2: "mtmux-docs", standalone: false },
  "apps/web": { pm2: "mtmux-app", standalone: true },
};

const app = process.argv[2];
const noReload = process.argv.includes("--no-reload");

if (!app || !APPS[app]) {
  console.error(
    `usage: node scripts/promote-build.mjs <${Object.keys(APPS).join("|")}> [--no-reload]`,
  );
  process.exit(2);
}

const { pm2: pm2Name, standalone } = APPS[app];
const APP_DIR = join(REPO, app);
const BUILD = join(APP_DIR, ".next-build");
const SERVE = join(APP_DIR, ".next-serve");
const PREV = join(APP_DIR, ".next-prev");

function fail(msg) {
  console.error(`[promote ${app}] ${msg}`);
  process.exit(1);
}

if (!existsSync(BUILD)) {
  fail(`no .next-build to promote — build ${app} first.`);
}

/**
 * A half-written tree still looks like a build directory from the outside, so
 * check for the files whose absence actually broke production rather than
 * just testing that the directory exists.
 */
const required = [
  "BUILD_ID",
  "routes-manifest.json",
  "prerender-manifest.json",
  "build-manifest.json",
  "server/chunks",
];

if (standalone) {
  // `output: standalone` omits .next/static and public/; a build promoted
  // without prepare-standalone serves HTML that 404s its own chunks.
  // The dist directory inside the standalone tree is named after `distDir`
  // (`.next-build`), not `.next`; server.js resolves static assets relative
  // to that name. It keeps that name after promotion — only the outer
  // directory is renamed — so this path is stable.
  required.push(
    `standalone/${app}/server.js`,
    `standalone/${app}/.next-build/static`,
  );
}

const missing = required.filter((f) => !existsSync(join(BUILD, f)));
if (missing.length > 0) {
  fail(
    `.next-build is incomplete, refusing to promote it.\n` +
      `           missing: ${missing.join(", ")}\n` +
      (missing.some((m) => m.startsWith("standalone/"))
        ? `           Run \`pnpm prepare:standalone\` after building.\n`
        : "") +
      `           Re-build and check it exits cleanly.`,
  );
}

// Directory renames are individually atomic on one filesystem; the gap between
// them is microseconds and the process is reloaded immediately after, so no
// worker ever reads a partial tree.
rmSync(PREV, { recursive: true, force: true });
if (existsSync(SERVE)) renameSync(SERVE, PREV);
renameSync(BUILD, SERVE);
console.log(
  `[promote ${app}] .next-build → .next-serve (previous kept as .next-prev)`,
);

if (noReload) {
  console.log(`[promote ${app}] --no-reload: pm2 not touched.`);
  process.exit(0);
}

/**
 * pm2 exits 0 for a reload that silently did nothing, and `pm2 reload <name>`
 * acts on one id when an app runs as a cluster — which is how a previous
 * deploy left one worker serving a replaced tree. So reload by id and prove
 * each one actually came back.
 */
function pm2List() {
  const out = execFileSync("pm2", ["jlist"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const start = out.indexOf("[{");
  if (start === -1) fail(`pm2 jlist returned no process array.`);
  return JSON.parse(out.slice(start));
}

const before = pm2List().filter((p) => p.name === pm2Name);
if (before.length === 0) {
  fail(
    `${pm2Name} is not known to pm2. The build is promoted but nothing was reloaded.`,
  );
}

for (const proc of before) {
  execFileSync("pm2", ["reload", String(proc.pm_id), "--update-env"], {
    stdio: "inherit",
  });
}

const after = new Map(pm2List().map((p) => [p.pm_id, p]));
const stale = [];
for (const proc of before) {
  const now = after.get(proc.pm_id);
  if (!now || now.pm2_env.status !== "online") {
    stale.push(`${pm2Name}#${proc.pm_id} is ${now?.pm2_env.status ?? "gone"}`);
  } else if (
    now.pid === proc.pid &&
    now.pm2_env.pm_uptime <= proc.pm2_env.pm_uptime
  ) {
    stale.push(`${pm2Name}#${proc.pm_id} did not restart (pid ${now.pid})`);
  }
}

if (stale.length > 0) {
  fail(
    `these processes are still serving the old build:\n` +
      stale.map((s) => `             ${s}`).join("\n") +
      `\n           Reload them by pm2 id before walking away.`,
  );
}

console.log(
  `[promote ${app}] ${pm2Name} reloaded (${before.length} process(es)).`,
);
