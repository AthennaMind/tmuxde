import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Where log lines go.
 *
 * `LOG_FILE` exists for one reason: inside the `mtmux` CLI the relay runs in
 * the same process as the banner and writes to the same fd. Every pane click,
 * split, resize and window switch produced a line of raw NDJSON — pid and
 * hostname included, because production skips pino-pretty — straight through
 * the QR code. The CLI's own output is a dozen lines that have to survive; the
 * relay's is a debugging aid that does not have to be on screen at all.
 *
 * `pino.destination` rather than a transport, deliberately. Transports spawn a
 * worker thread and resolve their target by module path, and neither survives
 * being bundled by esbuild into `dist/relay/runtime.js` — the CLI would start
 * and then die on its first log line.
 *
 * `sync: false` because a terminal server must never block on a disk write, and
 * `mkdir` because `~/.tmuxde/logs` does not exist on a first run.
 */
const dest = process.env.LOG_FILE;

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
    ...(isDev &&
      !dest && {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }),
  },
  dest ? pino.destination({ dest, mkdir: true, sync: false }) : undefined,
);

export type Logger = typeof logger;

export function createLogger(name: string) {
  return logger.child({ name });
}
