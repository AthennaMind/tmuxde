/**
 * Deploy the hosted stack: api.mtmux.com + app.mtmux.com.
 *
 * This exists because the three steps below are order-dependent and each one
 * fails in a way that looks like something else:
 *
 *  1. A plain `pnpm build` bakes NO NEXT_PUBLIC_API_URL into apps/web — Next
 *     inlines those at build time — so the pair page renders "not configured"
 *     and the CSP blocks the broker. It also picks up NEXT_PUBLIC_RELAY_URL
 *     from .env, pointing every visitor at ws://localhost:14300 on their own
 *     machine. So the build must carry explicit env.
 *  2. `output: "standalone"` omits .next/static and public/, so a build that is
 *     not followed by prepare-standalone serves HTML that 404s its own chunks.
 *  3. Rebuilding changes chunk hashes, so the running process must be reloaded
 *     or it serves a tree that no longer matches what it hands out.
 *  4. The build lands in .next-build while the workers serve .next-serve, so
 *     it has to be promoted before the reload — otherwise the reload brings
 *     back the same old tree and nothing appears to have deployed.
 *
 * Between steps 1 and 2 the bundle is checked for the API origin. That guard is
 * the point: every one of these failures produces a page that loads and looks
 * fine until someone tries to pair.
 */
import { execFileSync, execSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const API_ORIGIN = process.env.API_ORIGIN || "https://api.mtmux.com";
// The freshly built tree, not the one being served: the origin check has to
// run against what is about to be promoted.
const STATIC_DIR = path.join(REPO, "apps/web/.next-build/static/chunks");
const TARGETS = ["mtmux-api", "mtmux-app"];

function run(cmd, env = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, {
    stdio: "inherit",
    cwd: REPO,
    env: { ...process.env, ...env },
  });
}

/**
 * `pm2 jlist` prints a "PM2 is out-of-date" banner — and, when PM2+ is linked,
 * an activation line — on stdout *before* the JSON. So this cannot be a plain
 * JSON.parse; it has to slice from the first bracket.
 */
function pm2List() {
  const out = execFileSync("pm2", ["jlist"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const start = out.indexOf("[{");
  if (start === -1) {
    throw new Error(
      `pm2 jlist returned no process array:\n${out.slice(0, 400)}`,
    );
  }
  return JSON.parse(out.slice(start));
}

/**
 * Reload every pm2 id belonging to TARGETS, one call per id, then prove each
 * one actually restarted.
 *
 * Both halves matter. `pm2 reload mtmux-api mtmux-app` acts on the first match
 * only, and `mtmux-app` runs as two ids — which is how a previous deploy left
 * one process serving a .next tree the build had already replaced, 404ing its
 * own chunks until each id was reloaded by hand. And pm2 exits 0 for a reload
 * that silently did nothing, so the exit code is not evidence; a pid that
 * changed, or an uptime that moved forward, is.
 */
function reloadTargets() {
  const before = pm2List().filter((p) => TARGETS.includes(p.name));
  if (before.length === 0) {
    console.error(
      `✗ none of ${TARGETS.join(", ")} are known to pm2. Nothing was reloaded.`,
    );
    process.exit(1);
  }

  for (const proc of before) {
    console.log(`$ pm2 reload ${proc.pm_id}  (${proc.name})`);
    execFileSync("pm2", ["reload", String(proc.pm_id), "--update-env"], {
      stdio: "inherit",
    });
  }

  const after = new Map(pm2List().map((p) => [p.pm_id, p]));
  const stale = [];
  for (const proc of before) {
    const now = after.get(proc.pm_id);
    if (!now || now.pm2_env.status !== "online") {
      stale.push(
        `${proc.name}#${proc.pm_id} is ${now?.pm2_env.status ?? "gone"}`,
      );
      continue;
    }
    const restarted =
      now.pid !== proc.pid || now.pm2_env.pm_uptime > proc.pm2_env.pm_uptime;
    if (!restarted) {
      stale.push(`${proc.name}#${proc.pm_id} did not restart (pid ${now.pid})`);
      continue;
    }
    console.log(`  ✓ ${proc.name}#${proc.pm_id} restarted (pid ${now.pid})`);
  }

  if (stale.length > 0) {
    console.error(
      `✗ these processes are still serving the old build:\n` +
        stale.map((s) => `    ${s}`).join("\n") +
        `\n  Their .next tree has been replaced underneath them, so they will\n` +
        `  404 their own chunks. Reload them by pm2 id before walking away.`,
    );
    process.exit(1);
  }
}

console.log(`→ build (API_ORIGIN=${API_ORIGIN})`);
run("pnpm build:hosted", { API_ORIGIN });

console.log("→ verify the broker origin was baked in");
let found = false;
for (const entry of await readdir(STATIC_DIR, { recursive: true })) {
  if (!entry.endsWith(".js")) continue;
  const body = await readFile(path.join(STATIC_DIR, entry), "utf8");
  if (body.includes(API_ORIGIN)) {
    found = true;
    break;
  }
}
if (!found) {
  console.error(
    `✗ ${API_ORIGIN} is not in the client bundle.\n` +
      `  The pair page would render "not configured" and the CSP would block\n` +
      `  the broker. Refusing to deploy a bundle that cannot pair.`,
  );
  process.exit(1);
}
console.log("  ✓ present");

console.log("→ stage the standalone tree");
run("pnpm prepare:standalone");

// Promote before reloading, never after: the workers boot from .next-serve,
// so a reload against an unpromoted build just restarts the old tree.
console.log("→ promote the build into .next-serve");
run("node scripts/promote-build.mjs apps/web --no-reload");

console.log("→ reload");
reloadTargets();

console.log(`\n✓ deployed. Verify:  curl -s ${API_ORIGIN}/health`);
