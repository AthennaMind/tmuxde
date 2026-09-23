#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { start, type StartOpts } from "./commands/start.js";
import { pair } from "./commands/pair.js";
import { share, shareList, shareRevoke } from "./commands/share.js";
import { parseFiles } from "./share-grants.js";
import { tokenPrint, tokenRotate, tokenSet } from "./commands/token.js";
import { version } from "./commands/version.js";
import { configGet, configSet } from "./commands/config.js";
import { doctor } from "./commands/doctor.js";
import { status, stop } from "./commands/status.js";
import { approve } from "./commands/approve.js";
import {
  devicesList,
  devicesRename,
  devicesRevoke,
  devicesHistory,
} from "./commands/devices.js";
import {
  recordList,
  recordRemove,
  recordShare,
  recordStart,
  recordStop,
} from "./commands/record.js";
import { login, logout, servers, upgrade, whoami } from "./commands/account.js";
import { logs } from "./commands/logs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
) as { version: string };

const program = new Command();

program
  .name("mtmux")
  .description("tmux in your browser. One command, any device.")
  .version(pkg.version)
  // Global, because the relay's log level is a property of the process rather
  // than of any one command. Both write to stderr, never stdout, so `--json`
  // stays a parseable document.
  .option("--verbose", "mirror the relay log to stderr while running")
  .option(
    "--log-level <level>",
    "trace | debug | info | warn | error | fatal (default: info)",
  );

/** Flags that belong to the program rather than to a command. */
type GlobalFlags = { verbose?: boolean; logLevel?: string };

type StartFlags = {
  port: number;
  host?: string;
  token?: string;
  open: boolean;
  allowedPaths?: string;
  local?: boolean;
  hosted?: boolean;
  qr: boolean;
  name?: string;
  api?: string;
  json?: boolean;
  share?: string;
  readOnly?: boolean;
  files?: string;
  confirmReconnect?: boolean;
  trustReconnect?: boolean;
};

const toStartOpts = (opts: StartFlags, local: boolean): StartOpts => ({
  port: opts.port,
  host: opts.host,
  token: opts.token,
  open: opts.open,
  allowedPaths: opts.allowedPaths,
  // Tri-state on purpose. `undefined` means "nobody said", which is the only
  // value the stored `reach` setting is allowed to answer — an explicit
  // `--local` or `--hosted` must beat it in both directions.
  local: local || opts.local === true ? true : undefined,
  hosted: opts.hosted === true,
  qr: opts.qr,
  name: opts.name,
  api: opts.api,
  json: opts.json === true,
  share: opts.share,
  shareReadOnly: opts.readOnly === true,
  shareFiles: parseFiles(opts.files) ?? "none",
  /*
   * Both flags, and both tri-state.
   *
   * They were declared on the command and never carried across this boundary,
   * so `--confirm-reconnect` and `--trust-reconnect` had been accepted and
   * silently ignored: the stored `reconnectPolicy` decided every run whatever
   * was typed. Nothing said so — a flag that parses and does nothing is the
   * quietest kind of wrong. `undefined` has to survive here for the same
   * reason it does for `--local`: it is what lets the stored setting answer
   * when nobody said.
   */
  confirmReconnect: opts.confirmReconnect,
  trustReconnect: opts.trustReconnect,
  ...(program.opts<GlobalFlags>() as GlobalFlags),
});

/**
 * `start` is the default command, so `mtmux` on its own does the useful thing.
 *
 * It serves this network and contacts nobody. `--hosted` also opens a sealed
 * tunnel and prints a code for app.mtmux.com, which is what you want when the
 * phone is not on the same wifi — and `mtmux config set reach hosted` makes
 * that the default for this machine, so it is one decision rather than a flag
 * you retype forever.
 *
 * The default used to be the other way round. Reaching the internet is the
 * more useful behaviour *and* the one with consequences, and a default is
 * whatever happens to someone who typed the shortest command in the product
 * without reading what it does. Going out to a broker should be a thing you
 * asked for. `--local` still exists and still wins over everything, because an
 * explicit "not now" has to beat a stored preference. When the broker cannot
 * be reached, `--hosted` still degrades to exactly this rather than failing.
 */
program
  .command("start", { isDefault: true })
  .description("Serve this machine's tmux and print a code to open it")
  .option("-p, --port <number>", "port", (v) => parseInt(v, 10), 14100)
  // No default: `start` picks 0.0.0.0 when there is a real LAN to serve and
  // 127.0.0.1 otherwise. An explicit --host always wins.
  .option(
    "-h, --host <address>",
    "bind address (default: 0.0.0.0 on a LAN, else 127.0.0.1)",
  )
  .option("--local", "LAN and loopback only — never contact a broker")
  .option("--hosted", "also open a tunnel and print a code for app.mtmux.com")
  .option("--no-qr", "print the code without the QR block")
  .option("-n, --name <label>", "what to call this machine")
  .option("-t, --token <value>", "override the auth token for this run")
  .option("--allowed-paths <paths>", "comma-separated path allow-list")
  .option("--open", "also open the browser on this machine", false)
  .option("--api <url>", "pairing service base URL")
  .option(
    "--confirm-reconnect",
    "ask before letting a previously paired device back in",
  )
  .option("--trust-reconnect", "let previously paired devices back in silently")
  .option("--json", "print a machine-readable startup record")
  .option(
    "--share <sessions>",
    "scope the printed code to these tmux sessions (comma-separated)",
  )
  .option("--read-only", "with --share: they can watch, and cannot type")
  .option("--files <level>", "with --share: none | ro | rw (default: none)")
  .action((opts: StartFlags) => start(toStartOpts(opts, false)));

/**
 * Kept, although `start` now does this by default.
 *
 * It costs nothing and it says what it means at the call site — in a systemd
 * unit or a README, `mtmux local` is self-documenting in a way that relying on
 * a default is not, and it stays correct if this machine's `reach` is later
 * set to `hosted`.
 */
program
  .command("local")
  .description("Serve on this network only, whatever `reach` is set to")
  .option("-p, --port <number>", "port", (v) => parseInt(v, 10), 14100)
  .option("-h, --host <address>", "bind address")
  .option("--no-qr", "print without the QR block")
  .option("-t, --token <value>", "override the auth token for this run")
  .option("--allowed-paths <paths>", "comma-separated path allow-list")
  .option("--open", "also open the browser on this machine", false)
  .option("--json", "print a machine-readable startup record")
  .action((opts: StartFlags) => start(toStartOpts(opts, true)));

/**
 * `mtmux logs` — where the relay's output went.
 *
 * It used to print over the banner, because the relay runs in this process and
 * its logger writes to fd 1. Moving it to `~/.mtmux/logs/mtmux.log` is only
 * defensible if there is a way to read it back.
 */
program
  .command("logs")
  .description("Show the relay log")
  .option("-n, --lines <count>", "how many lines", (v) => parseInt(v, 10), 200)
  .option("-f, --follow", "keep printing new lines until Ctrl+C")
  .option("--json", "print the raw NDJSON instead of formatting it")
  .action((opts: { lines: number; follow?: boolean; json?: boolean }) =>
    logs({
      lines: opts.lines,
      follow: opts.follow === true,
      json: opts.json === true,
    }),
  );

program
  .command("pair")
  .argument("[code]", "the code shown in the browser")
  .description("Join a pairing that a browser started")
  .option(
    "-p, --port <number>",
    "port mtmux is serving on",
    (v) => parseInt(v, 10),
    14100,
  )
  .option("--api <url>", "pairing service base URL")
  .option(
    "--tunnel-only",
    "never advertise a direct address; always relay through the tunnel",
  )
  .action(
    (
      code: string | undefined,
      opts: { port: number; api?: string; tunnelOnly?: boolean },
    ) =>
      pair({
        code,
        port: opts.port,
        api: opts.api,
        tunnelOnly: opts.tunnelOnly,
      }),
  );

/**
 * `mtmux share` — one session, one code, not the whole machine.
 *
 * Defaults to read-write, which is what people mean when they say "share my
 * terminal" and is *not* a security boundary. The banner printed before the
 * code says so in as many words; see `shareBanner`. `--read-only` is the mode
 * that is a boundary.
 */
const shareCmd = program
  .command("share")
  .description(
    "Share one tmux session with someone, without sharing the machine",
  );

shareCmd
  .command("list", { isDefault: false })
  .description("Show every share created on this machine")
  .action(() => shareList());

shareCmd
  .command("revoke")
  .argument("<grantId>", "the grn_… id from `mtmux share list`")
  .description("End a share immediately")
  .option(
    "-p, --port <number>",
    "port mtmux is serving on",
    (v) => parseInt(v, 10),
    14100,
  )
  .action((grantId: string, opts: { port: number }) =>
    shareRevoke(grantId, opts.port),
  );

shareCmd
  .argument(
    "[session]",
    "the tmux session to share (comma-separate for several)",
  )
  .option(
    "-p, --port <number>",
    "port mtmux is serving on",
    (v) => parseInt(v, 10),
    14100,
  )
  .option("--api <url>", "pairing service base URL")
  .option("--read-only", "they can watch, and cannot type — a real boundary")
  .option("--files <level>", "none | ro | rw (default: none)", "none")
  .option("--expires <duration>", "24h, 7d, or never", "7d")
  .option("--label <text>", "what to call this share in `mtmux share list`")
  .option("--no-qr", "print only the code, without the QR")
  .action(
    (
      session: string | undefined,
      opts: {
        port: number;
        api?: string;
        readOnly?: boolean;
        files: string;
        expires: string;
        label?: string;
        qr: boolean;
      },
    ) => {
      if (!session) {
        shareCmd.help();
        return;
      }
      const files = parseFiles(opts.files);
      if (!files) {
        console.error(
          `Could not read --files "${opts.files}". Try none, ro, or rw.`,
        );
        process.exitCode = 1;
        return;
      }
      return share({
        session,
        port: opts.port,
        api: opts.api,
        readOnly: opts.readOnly === true,
        files,
        expires: opts.expires,
        label: opts.label,
        qr: opts.qr,
      });
    },
  );

/**
 * `mtmux record` — capture what happened, to a file you own.
 *
 * A subcommand tree rather than a flag on `mtmux start`. Recording is something
 * you start when the thing worth recording is about to happen; `--record` would
 * mean deciding minutes earlier, and would make the answer to "am I recording?"
 * a property of how the server was booted.
 */
const recordCmd = program
  .command("record")
  .description("Record a tmux session or pane to a file on this machine");

const portOption = (cmd: Command) =>
  cmd.option(
    "-p, --port <number>",
    "port mtmux is serving on",
    (v) => parseInt(v, 10),
    14100,
  );

recordCmd
  .command("list")
  .description("Show every recording on this machine")
  .option("--json", "print one JSON document and nothing else")
  .action((opts: { json?: boolean }) => recordList(opts.json === true));

portOption(recordCmd.command("stop"))
  .argument("[id]", "the rec_… id from `mtmux record list`")
  .option("--all", "stop every recording")
  .description("Stop a recording and close its file")
  .action((id: string | undefined, opts: { port: number; all?: boolean }) =>
    recordStop(id, opts.port, opts.all === true),
  );

portOption(recordCmd.command("rm"))
  .argument("<id>", "the rec_… id from `mtmux record list`")
  .description("Delete a recording and its file")
  .action((id: string, opts: { port: number }) => recordRemove(id, opts.port));

portOption(recordCmd.command("share"))
  .argument("<id>", "the rec_… id from `mtmux record list`")
  .option("--api <url>", "pairing service base URL")
  .option("--expires <duration>", "24h, 7d, or never", "7d")
  .option("--label <text>", "what to call this share in `mtmux share list`")
  .option("--no-qr", "print only the code, without the QR")
  .description("Give somebody a copy of a recording")
  .action(
    (
      id: string,
      opts: {
        port: number;
        api?: string;
        expires: string;
        label?: string;
        qr: boolean;
      },
    ) =>
      recordShare({
        id,
        port: opts.port,
        api: opts.api,
        expires: opts.expires,
        label: opts.label,
        qr: opts.qr,
      }),
  );

portOption(recordCmd)
  .argument("[session]", "the tmux session to record")
  .option("--pane <id>", "record one pane (a tmux %id) instead of the session")
  .option(
    "--title <text>",
    "what the recording is called, instead of the session name",
  )
  .action(
    (
      session: string | undefined,
      opts: { port: number; pane?: string; title?: string },
    ) => {
      if (!session) {
        recordCmd.help();
        return;
      }
      return recordStart({
        session,
        port: opts.port,
        pane: opts.pane,
        title: opts.title,
      });
    },
  );

/**
 * The way in for a machine nobody is sitting at.
 *
 * A dashboard access request needs a human to compare six digits, and a box
 * running as a service has none — so it denies, correctly. This opens a window
 * during which the request is shown *here* instead. Purely additive: without
 * it, everything behaves exactly as it did.
 */
program
  .command("approve")
  .description("Wait for a browser's access request and approve it here")
  .option(
    "-t, --timeout <minutes>",
    "how long to stay available",
    (v) => parseInt(v, 10),
    5,
  )
  .option(
    "-p, --port <number>",
    "port the server is on (default: whatever is running)",
    (v) => parseInt(v, 10),
    0,
  )
  .option("--keep", "stay open after the first decision", false)
  .action((opts: { timeout: number; port: number; keep: boolean }) =>
    approve({ timeout: opts.timeout, port: opts.port, keep: opts.keep }),
  );

program
  .command("status")
  .description("Show the server running on this machine")
  .action(status);

program
  .command("stop")
  .description("Stop the server running on this machine")
  .action(stop);

program
  .command("doctor")
  .description("Check everything mtmux needs")
  .option("-p, --port <number>", "port to check", (v) => parseInt(v, 10), 14100)
  .option("--api <url>", "pairing service base URL")
  .action((opts: { port: number; api?: string }) => doctor(opts));

program
  .command("login")
  .description("Sign in — optional, adds the dashboard and more servers")
  .option("--api <url>", "pairing service base URL")
  .option("--no-open", "don't open the browser")
  .action((opts: { api?: string; open: boolean }) =>
    login({ api: opts.api, open: opts.open }),
  );

program
  .command("logout")
  .description("Sign out on this machine")
  .option("--api <url>", "pairing service base URL")
  .action((opts: { api?: string }) => logout(opts));

program
  .command("whoami")
  .description("Show the signed-in account")
  .option("--api <url>", "pairing service base URL")
  .action((opts: { api?: string }) => whoami(opts));

program
  .command("servers")
  .description("List the machines on your account")
  .option("--api <url>", "pairing service base URL")
  .action((opts: { api?: string }) => servers(opts));

program
  .command("upgrade")
  .description("Open checkout for mtmux Pro")
  .option("--api <url>", "pairing service base URL")
  .option("--no-open", "don't open the browser")
  .action((opts: { api?: string; open: boolean }) =>
    upgrade({ api: opts.api, open: opts.open }),
  );

const devices = program
  .command("devices")
  .description("Browsers paired with this machine")
  .action(devicesList);
devices
  .command("list", { isDefault: true })
  .description("List paired devices")
  .action(devicesList);
devices
  .command("history")
  .description("Every connection this machine has admitted")
  .option("-n, --limit <count>", "how many entries to show", "50")
  .action((opts: { limit: string }) =>
    devicesHistory({ limit: Number(opts.limit) || 50 }),
  );
devices
  .command("rename <deviceId> [name...]")
  .description("Call a device something of your own — no name clears it")
  .action((deviceId: string, name: string[]) => devicesRename(deviceId, name));
devices
  // `remove` is what the live panel calls it, and one act with two names is
  // one act somebody has to look up. `revoke` stays as an alias forever: it
  // is in scripts, in older docs and in this terminal's own scrollback.
  .command("remove <deviceId>")
  .alias("revoke")
  .description("Forget a device — it must pair again, with a new code")
  .action(devicesRevoke);

const token = program.command("token").description("Manage the auth token");
token.command("print").description("Show the current token").action(tokenPrint);
token.command("rotate").description("Generate a new token").action(tokenRotate);
token
  .command("set <value>")
  .description("Set the token to a specific value")
  .action(tokenSet);

const config = program
  .command("config")
  .description("Read and change settings");
config
  .command("get [key]")
  .description("Show a setting, or all of them")
  .action(configGet);
config
  .command("set <key> <value>")
  .description("Change a setting")
  .action(configSet);

program
  .command("version")
  .alias("v")
  .description("Print version info")
  .action(version);

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
