// Smoke test the built CLI:
//   1. boot `node dist/bin.js start --port <free>`
//   2. probe /health, /, /_relay (websocket upgrade)
//   3. kill the process; exit non-zero on any failure
//
// Used by `pnpm --filter mtmux test` and the cli-smoke CI job.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "dist/bin.js");
const PORT = Number(process.env.SMOKE_PORT ?? 0) || pickPort();

if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`pnpm --filter mtmux build\` first.`);
  process.exit(1);
}

function pickPort() {
  return 39000 + Math.floor(Math.random() * 500);
}

function fetch(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method: "GET", timeout: 3000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function request(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        method,
        timeout: 3000,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Open a socket, send one auth frame, resolve with the server's reply. */
function tryAuth(token) {
  return new Promise((resolve, reject) => {
    import("ws").then(({ default: WS }) => {
      const ws = new WS(`ws://127.0.0.1:${PORT}/_relay`, {
        headers: {
          Origin: `http://127.0.0.1:${PORT}`,
          "User-Agent": "Mozilla/5.0 SmokeTest",
        },
      });
      const t = setTimeout(() => {
        ws.close();
        reject(new Error("no auth reply within 4s"));
      }, 4000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
      ws.on("message", (d) => {
        clearTimeout(t);
        const msg = JSON.parse(d.toString());
        ws.close();
        resolve(msg);
      });
      ws.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    }, reject);
  });
}

function probeUpgrade(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: PORT,
      path,
      method: "GET",
      timeout: 3000,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode });
    });
    req.on("response", (res) => resolve({ status: res.statusCode }));
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

console.log(`→ booting CLI on port ${PORT}`);
const child = spawn("node", [BIN, "start", "--port", String(PORT)], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_ENV: "production" },
});

const stderr = [];
const stdout = [];
child.stdout.on("data", (b) => {
  stdout.push(b);
  process.stdout.write(b);
});
child.stderr.on("data", (b) => {
  stderr.push(b);
  process.stderr.write(b);
});

let exited = false;
child.on("exit", (code) => {
  exited = true;
  if (code !== 0 && code !== null) {
    console.error(`✗ CLI exited with code ${code} during smoke test`);
    process.exit(1);
  }
});

// Give the server time to listen + Next prepare
await sleep(7000);

if (exited) {
  console.error("✗ CLI exited before smoke probes ran");
  process.exit(1);
}

/**
 * Run a CLI invocation to exit and hand back its stdout.
 *
 * `--json` and `logs` both terminate on their own; `start` without `--json`
 * does not, so anything using this must be one of the two that does — or pass
 * a deadline and accept whatever was printed by then.
 */
function runToCompletion(argv, killAfterMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "production" },
    });
    const chunks = [];
    proc.stdout.on("data", (b) => chunks.push(b));
    const timer = killAfterMs
      ? setTimeout(() => proc.kill("SIGTERM"), killAfterMs)
      : setTimeout(() => proc.kill("SIGKILL"), 20000);
    proc.on("error", reject);
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

let failed = false;
async function check(name, fn) {
  try {
    const result = await fn();
    console.log(`  ✓ ${name}: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed = true;
  }
}

await check("/health returns 200", async () => {
  const r = await fetch("/health");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!r.body.includes('"status":"ok"'))
    throw new Error(`unexpected body: ${r.body}`);
  return r.status;
});

await check("/ returns Next.js HTML", async () => {
  const r = await fetch("/");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!r.body.includes("<!DOCTYPE html>"))
    throw new Error("no <!DOCTYPE html> in body");
  return { status: r.status, bytes: r.body.length };
});

await check("/_relay accepts WS upgrade", async () => {
  const r = await probeUpgrade("/_relay");
  if (r.status !== 101) throw new Error(`expected 101, got ${r.status}`);
  return r.status;
});

// Regression guard: in our embedded setup Next.js's NextServer used to
// register its own `upgrade` listener on first request, which would
// destroy /_relay sockets after handshake. Ensure a real WS auth flow
// still works after Next has handled an HTTP request.
await check("WS auth survives a prior Next request", async () => {
  const { default: WS } = await import("ws");
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const cfg = JSON.parse(
    await readFile(join(homedir(), ".mtmux/config.json"), "utf8"),
  );
  return await new Promise((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${PORT}/_relay`, {
      headers: {
        Origin: `http://127.0.0.1:${PORT}`,
        "User-Agent": "Mozilla/5.0 SmokeTest",
      },
    });
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("no auth:success within 4s"));
    }, 4000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "auth", token: cfg.token })),
    );
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === "auth:success") {
        clearTimeout(t);
        ws.close();
        resolve("auth:success");
      } else if (msg.type === "auth:failure") {
        clearTimeout(t);
        ws.close();
        reject(new Error(`auth:failure ${msg.reason}`));
      }
    });
    ws.on("close", (code) => {
      clearTimeout(t);
      reject(new Error(`closed ${code} before auth:success`));
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
});

await check("/_pair/local rejects an unknown nonce", async () => {
  const r = await request(
    "POST",
    "/_pair/local",
    JSON.stringify({ nonce: "definitely-not-a-real-nonce" }),
  );
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  return r.status;
});

await check("/_pair/local rejects GET", async () => {
  const r = await request("GET", "/_pair/local");
  if (r.status !== 405) throw new Error(`expected 405, got ${r.status}`);
  return r.status;
});

await check("/_pair/local rejects a malformed body", async () => {
  const r = await request("POST", "/_pair/local", "{ not json");
  if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  return r.status;
});

/*
 * A JSON content type is not a "simple request", so a cross-origin POST has to
 * preflight and this origin answers no preflight. Without the check, a page on
 * the open internet could burn the code on screen from the browser of anyone
 * sitting on this wifi.
 */
await check("/_pair/local refuses a form-style content type", async () => {
  const r = await request(
    "POST",
    "/_pair/local",
    JSON.stringify({ code: "1" }),
    {
      "Content-Type": "text/plain",
    },
  );
  if (r.status !== 415) throw new Error(`expected 415, got ${r.status}`);
  return r.status;
});

/* The banner is the front door in local mode, and it has to hold a code. */
await check("the banner prints six digits to type", () => {
  const match = /and enter (\d{3} \d{3})/.exec(
    Buffer.concat(stdout).toString("utf8"),
  );
  if (!match) throw new Error("no typed code on the banner");
  return match[1];
});

/*
 * The whole point of the gate, end to end: the *right* code is not enough.
 *
 * This process has no TTY, no panel and no connected browser, so there is
 * nobody to ask — and "could not ask" has to land as a refusal rather than as
 * an admission. Before the gate existed, a correct code here minted a
 * full-grant session token with no human anywhere in the loop.
 *
 * It also spends the code, so the offer re-arms and the next reader gets a
 * different six digits. That is the behaviour under test as much as the 403.
 */
await check(
  "the right code still needs a human, and there is none",
  async () => {
    const printed = /and enter (\d{3} \d{3})/.exec(
      Buffer.concat(stdout).toString("utf8"),
    );
    if (!printed) throw new Error("no typed code on the banner");
    // Either answer is the gate working. With nobody to ask, the request is
    // *held* for the offer window so `mtmux approve` in another shell can still
    // answer it — so this times out rather than returning, and a refusal is
    // what it becomes. The property under test is the one thing neither of them
    // is: a session token.
    const reply = await request(
      "POST",
      "/_pair/local",
      JSON.stringify({ code: printed[1].replace(" ", ""), label: "smoke" }),
    ).catch(() => ({ status: "held", body: "" }));
    if (reply.status === 200 || /"session"/.test(reply.body ?? "")) {
      throw new Error("the right code alone minted a session");
    }
    if (reply.status !== "held" && reply.status !== 403) {
      throw new Error(`expected a refusal or a hold, got ${reply.status}`);
    }
    return reply.status === "held" ? "held for a human" : "refused";
  },
);

// Runs last: it deliberately locks 127.0.0.1 out, so anything needing a
// successful auth must already have happened.
await check("failed auth locks the address out after five tries", async () => {
  for (let i = 0; i < 5; i++) {
    const reply = await tryAuth(`wrong-token-${i}`);
    if (reply.type !== "auth:failure")
      throw new Error(`attempt ${i}: expected auth:failure, got ${reply.type}`);
  }
  const sixth = await tryAuth("wrong-token-5");
  if (sixth.type !== "auth:failure")
    throw new Error(`expected auth:failure, got ${sixth.type}`);
  if (!/Too many failed attempts/.test(sixth.reason ?? ""))
    throw new Error(`expected a backoff message, got: ${sixth.reason}`);
  return sixth.reason;
});

// The banner used to compete with the embedded relay's NDJSON on fd 1 — every
// pane click, split and resize printed straight through the QR code. The relay
// now logs to ~/.mtmux/logs/mtmux.log, so stdout is banner and nothing else.
await check("stdout carries no log lines", async () => {
  const text = Buffer.concat(stdout).toString("utf8");
  const ndjson = text
    .split("\n")
    .filter((line) => /^\s*\{.*"level"\s*:\s*\d+/.test(line));
  if (ndjson.length > 0) {
    throw new Error(`found ${ndjson.length} log lines, e.g. ${ndjson[0]}`);
  }
  return "clean";
});

// `--json` used to print a pretty document into a stream the relay was
// concurrently writing NDJSON to, so it was never reliably parseable.
await check(
  "--json prints one parseable document and nothing else",
  async () => {
    const port = pickPort();
    const out = await runToCompletion([
      BIN,
      "start",
      "--port",
      String(port),
      "--local",
      "--json",
    ]);
    const parsed = JSON.parse(out.trim());
    if (typeof parsed.localUrl !== "string") {
      throw new Error(`no localUrl in ${out.slice(0, 120)}`);
    }
    return parsed.mode;
  },
);

/*
 * The headline claim, proved end to end: a valid credential is not entry.
 *
 * Every connection is put to a human at the machine — see
 * `connection-gate.ts` — so on a server with no terminal, no panel and no
 * `mtmux approve` window, a *correct* token must still get nowhere. This runs
 * a second server with `--confirm-reconnect` because that is what a person
 * sitting at a terminal gets by default; the first server in this file is
 * headless and deliberately trusts, which is the behaviour that keeps systemd
 * units working across an upgrade.
 */
await check(
  "a valid token is not permission, and nobody is there",
  async () => {
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { default: WS } = await import("ws");
    const cfg = JSON.parse(
      await readFile(join(homedir(), ".mtmux/config.json"), "utf8"),
    );

    const port = pickPort();
    const gated = spawn(
      "node",
      [BIN, "start", "--port", String(port), "--local", "--confirm-reconnect"],
      {
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, NODE_ENV: "production" },
      },
    );
    try {
      // Polled rather than slept on: this one boots Next a second time on a
      // busy machine, and a fixed wait here is a flaky test rather than a fast
      // one.
      let listening = false;
      for (let i = 0; i < 40 && !listening; i++) {
        await sleep(1000);
        listening = await new Promise((resolve) => {
          const req = http.request(
            { host: "127.0.0.1", port, path: "/health", timeout: 1000 },
            (res) => {
              res.resume();
              resolve(res.statusCode === 200);
            },
          );
          req.on("error", () => resolve(false));
          req.on("timeout", () => {
            req.destroy();
            resolve(false);
          });
          req.end();
        });
      }
      if (!listening) throw new Error("the gated server never came up");
      const reply = await new Promise((resolve, reject) => {
        const ws = new WS(`ws://127.0.0.1:${port}/_relay`, {
          headers: {
            Origin: `http://127.0.0.1:${port}`,
            "User-Agent": "Mozilla/5.0 SmokeTest",
          },
        });
        // Long enough for the question to be raised, parked and refused with
        // nothing to answer on — which is the outcome being asserted.
        const t = setTimeout(() => {
          ws.close();
          resolve({ type: "silence" });
        }, 20000);
        ws.on("open", () =>
          ws.send(JSON.stringify({ type: "auth", token: cfg.token })),
        );
        ws.on("message", (d) => {
          clearTimeout(t);
          ws.close();
          resolve(JSON.parse(d.toString()));
        });
        ws.on("error", (e) => {
          clearTimeout(t);
          reject(e);
        });
      });
      if (reply.type === "auth:success") {
        throw new Error("a token alone got in with nobody to approve it");
      }
      if (reply.type === "auth:failure" && reply.code !== "unapproved") {
        // The distinction the browser branches on: a refusal must not read as a
        // dead credential, or every slow answer wipes a working pairing.
        throw new Error(`refused without the code: ${reply.reason}`);
      }
      return reply.type === "silence" ? "held, never admitted" : reply.reason;
    } finally {
      gated.kill("SIGKILL");
    }
  },
);

await check("mtmux logs reads back what left the terminal", async () => {
  const out = await runToCompletion([BIN, "logs", "-n", "20"], 4000);
  // Either real lines, or the honest "nothing yet" message — never a crash.
  if (!/relay|No logs yet|mtmux/i.test(out)) {
    throw new Error(`unexpected output: ${out.slice(0, 200)}`);
  }
  return out.split("\n").length + " lines";
});

console.log("→ shutting down");
child.kill("SIGTERM");
await sleep(500);
if (!exited) child.kill("SIGKILL");

if (failed) {
  console.error("✗ smoke test failed");
  process.exit(1);
}
console.log("✓ smoke test passed");
