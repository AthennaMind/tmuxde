#!/usr/bin/env node
/**
 * The mtmux lab — a containerized tmux population to test against.
 *
 *   node scripts/lab.mjs up      build if needed, start, wait until healthy
 *   node scripts/lab.mjs down    stop and remove the container
 *   node scripts/lab.mjs reset   re-seed in place, no rebuild, no restart
 *   node scripts/lab.mjs seed    create any missing sessions
 *   node scripts/lab.mjs status  what is actually running in there
 *   node scripts/lab.mjs logs    follow the relay's log
 *   node scripts/lab.mjs env     print the variables the harness needs
 *
 * ## Why a script rather than a compose invocation people type
 *
 * `up` has to do two builds, in order, with `docker build` rather than
 * `docker compose build`. `docker/Dockerfile.tmux-lab` starts `FROM` the relay
 * image's `runner` stage, because the whole value of the rig is that it drives
 * the relay people actually run rather than a lookalike assembled for testing
 * — and Docker cannot reach into another Dockerfile's stage, so that image has
 * to exist and be tagged first.
 *
 * Both halves of that bit once. Compose builds on whatever buildx builder is
 * selected, and a `docker-container` builder keeps its own cache and cannot
 * read the local image store, so it resolved `mtmux-relay:lab` as a Docker Hub
 * repository and failed with `pull access denied` for an image that has never
 * been published. The default `docker` driver, which is what plain
 * `docker build` uses here, does see it. Hence both builds below, and
 * `pull_policy: never` in the compose file.
 */
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = path.join(ROOT, "docker/tmux-lab/compose.yml");

/** The relay image the lab layers on. Tagged `:lab` so it cannot be mistaken
 *  for anything deployable. */
export const RELAY_IMAGE = "mtmux-relay:lab";

/** The lab image. `latest` only because compose names it; it is never pushed. */
export const LAB_IMAGE = "mtmux-lab:latest";

/**
 * Ports, and why these ones.
 *
 * CLAUDE.md invariant 8: 14100, 24100, 24400, 24102 and 41317 are load-bearing
 * — nginx points at them and PM2 is holding several right now. 24300 is the
 * supported relay container's. These two are clear of all of it, and the `90`
 * suffix is meant to read as "the lab's copy of" at a glance.
 */
export const LAB_RELAY_PORT = Number(process.env.LAB_RELAY_PORT ?? 24390);
export const LAB_WEB_PORT = Number(process.env.LAB_WEB_PORT ?? 14190);

/**
 * The lab's relay token.
 *
 * Fixed, and that is not a lapse. The Playwright fixture has to seed the same
 * string into `localStorage` under `mtmux-token` for the app's auth guard to
 * render the terminal at all, and a generated token would mean the harness and
 * the container negotiating one. It is safe because the container publishes
 * only on 127.0.0.1 and holds nothing but synthetic sessions. It is also
 * non-default on purpose: `apps/relay/src/config.ts` throws on the well-known
 * default token when bound to a non-loopback host, which is what the relay is
 * inside a container.
 */
export const LAB_AUTH_TOKEN =
  process.env.LAB_AUTH_TOKEN ?? "mtmux-lab-token-not-for-production";

const labEnv = {
  ...process.env,
  LAB_RELAY_IMAGE: RELAY_IMAGE,
  LAB_RELAY_PORT: String(LAB_RELAY_PORT),
  LAB_WEB_PORT: String(LAB_WEB_PORT),
  LAB_AUTH_TOKEN,
};

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    env: labEnv,
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

/** `opts` is a second argument, never a trailing member of `args` — a
 *  spread signature here once sent `[object Object]` to compose as a service
 *  name, which it reports as "no such service" rather than as a type error. */
const compose = (args, opts) =>
  run("docker", ["compose", "-f", COMPOSE, ...args], opts);

function containerId() {
  try {
    return compose(["ps", "-q", "lab"], { capture: true }).trim() || null;
  } catch {
    return null;
  }
}

/** `docker exec` into the lab, for the seed script's own subcommands. */
function inLab(args, opts = {}) {
  const id = containerId();
  if (!id)
    throw new Error("the lab is not running — `node scripts/lab.mjs up`");
  return run("docker", ["exec", id, ...args], opts);
}

function health(id) {
  try {
    const out = run(
      "docker",
      ["inspect", "-f", "{{.State.Health.Status}}", id],
      { capture: true },
    );
    return out.trim();
  } catch {
    return "unknown";
  }
}

/**
 * Block until the container reports healthy.
 *
 * The healthcheck is `seed.sh check`, which demands every session *and* a
 * scrollback pane that has actually filled. Waiting on "container started"
 * instead is how a suite ends up racing its own fixture, and a race in a
 * fixture reads as flake in whatever spec happened to run first.
 */
async function waitHealthy(timeoutMs = 180_000) {
  const id = containerId();
  if (!id) throw new Error("no lab container");
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const status = health(id);
    if (status !== last) {
      process.stdout.write(`lab: ${status}\n`);
      last = status;
    }
    if (status === "healthy") return;
    if (status === "unknown") {
      throw new Error("lab container has no healthcheck — rebuild the image");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  compose(["logs", "--tail", "60", "lab"]);
  throw new Error(`lab did not become healthy within ${timeoutMs / 1000}s`);
}

/** The image the lab layers on: the shipped relay, at its `runner` stage. */
function buildRelayImage() {
  process.stdout.write(`lab: building ${RELAY_IMAGE} (relay runner stage)\n`);
  run("docker", [
    "build",
    "-f",
    "docker/Dockerfile.relay",
    "--target",
    "runner",
    "-t",
    RELAY_IMAGE,
    ".",
  ]);
}

/** The lab image itself. Must run after `buildRelayImage`; see the header. */
function buildLabImage() {
  process.stdout.write("lab: building mtmux-lab:latest\n");
  run("docker", [
    "build",
    "-f",
    "docker/Dockerfile.tmux-lab",
    "--build-arg",
    `RELAY_IMAGE=${RELAY_IMAGE}`,
    "-t",
    LAB_IMAGE,
    ".",
  ]);
}

const commands = {
  async up() {
    buildRelayImage();
    buildLabImage();
    compose(["up", "-d", "--force-recreate"]);
    await waitHealthy();
    commands.status();
    process.stdout.write(
      `\nlab relay: ws://127.0.0.1:${LAB_RELAY_PORT}\n` +
        `lab web:   http://127.0.0.1:${LAB_WEB_PORT} (started by Playwright)\n`,
    );
  },

  down() {
    compose(["down", "-v", "--remove-orphans"]);
  },

  /** A clean slate without a container restart — seconds rather than a minute. */
  reset() {
    inLab(["/lab/seed.sh", "reset"]);
    process.stdout.write("lab: re-seeded\n");
  },

  seed() {
    inLab(["/lab/seed.sh", "seed"]);
    process.stdout.write("lab: seeded\n");
  },

  status() {
    process.stdout.write(inLab(["/lab/seed.sh", "status"], { capture: true }));
  },

  logs() {
    spawn("docker", ["compose", "-f", COMPOSE, "logs", "-f", "lab"], {
      cwd: ROOT,
      env: labEnv,
      stdio: "inherit",
    });
  },

  /** Consumed by `playwright.config.ts` and by anyone driving this by hand. */
  env() {
    process.stdout.write(
      [
        `E2E_PORT=${LAB_WEB_PORT}`,
        `E2E_RELAY_TOKEN=${LAB_AUTH_TOKEN}`,
        `NEXT_PUBLIC_RELAY_URL=ws://127.0.0.1:${LAB_RELAY_PORT}`,
        "",
      ].join("\n"),
    );
  },
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const name = process.argv[2] ?? "up";
  const cmd = commands[name];
  if (!cmd) {
    process.stderr.write(
      `unknown command "${name}" — use ${Object.keys(commands).join(", ")}\n`,
    );
    process.exit(2);
  }
  try {
    await cmd();
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
