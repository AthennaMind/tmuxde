import { z } from "zod";

const DEFAULT_AUTH_TOKEN = "change-me-in-production";

const ConfigSchema = z.object({
  port: z.coerce.number().default(14300),
  host: z.string().default("127.0.0.1"),
  authToken: z.string().default(DEFAULT_AUTH_TOKEN),
  allowedPaths: z
    .string()
    .default("/home")
    .transform((s) =>
      s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  tmuxSocket: z.string().default(""),
  tmuxDefaultShell: z.string().default("/bin/bash"),
  wsRateLimit: z.coerce.number().default(100),
  idleTimeoutMinutes: z.coerce.number().default(30),
  /**
   * Optional speech service for dictation, e.g. `ws://stt:24400`. Unset means
   * dictation is off and browsers are offered no mic.
   */
  sttUrl: z
    .string()
    .url()
    .regex(/^wss?:\/\//, "STT_URL must be a ws:// or wss:// URL")
    .optional(),
  corsOrigins: z
    .string()
    .default("http://localhost:14100")
    // Empty (e.g. the CLI's same-origin single-port mode) means "no Origin
    // restriction"; filter blanks so "" doesn't become [""] and reject everyone.
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
});

export const config = ConfigSchema.parse({
  port: process.env.RELAY_PORT,
  host: process.env.RELAY_HOST,
  authToken: process.env.AUTH_TOKEN,
  allowedPaths: process.env.ALLOWED_PATHS,
  tmuxSocket: process.env.TMUX_SOCKET,
  tmuxDefaultShell: process.env.TMUX_DEFAULT_SHELL,
  wsRateLimit: process.env.WS_RATE_LIMIT,
  idleTimeoutMinutes: process.env.IDLE_TIMEOUT_MINUTES,
  corsOrigins: process.env.CORS_ORIGINS,
  // Compose passes an empty string when dictation is off.
  sttUrl: process.env.STT_URL || undefined,
});

// Refuse the default/empty token when bound to a non-loopback host — a
// network-exposed relay with the well-known token is effectively open. On
// loopback (the default, and local dev) it's only reachable locally, so we
// allow it there to keep `pnpm dev` friction-free.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", ""]);
const tokenIsDefault =
  config.authToken === DEFAULT_AUTH_TOKEN || config.authToken.trim() === "";
if (tokenIsDefault && !LOOPBACK_HOSTS.has(config.host)) {
  throw new Error(
    `AUTH_TOKEN must be set to a non-default value when binding to a non-loopback host (RELAY_HOST=${config.host}). ` +
      "Generate one with `openssl rand -hex 32` and set it in .env. " +
      "See .env.example for details.",
  );
}

if (
  process.env.NODE_ENV === "production" &&
  config.corsOrigins.some((o) => o.startsWith("http://localhost"))
) {
  throw new Error(
    "CORS_ORIGINS must be set to your production origin(s) and must not include localhost in production. " +
      "Set CORS_ORIGINS in .env to e.g. 'https://yourdomain.com'.",
  );
}
