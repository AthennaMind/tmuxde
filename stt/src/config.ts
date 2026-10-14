import { isAbsolute } from "node:path";
import { z } from "zod";

// sun_path is 108 bytes on Linux, including the closing NUL.
const MAX_SOCKET_PATH_BYTES = 107;

const ConfigSchema = z.object({
  /**
   * Unix socket the service listens on. The tmuxde server dials it, and the
   * container health check uses it too. There is no TCP listener.
   */
  socket: z
    .string({ required_error: "STT_SOCKET is required" })
    .refine(isAbsolute, "must be an absolute path")
    .refine(
      (path) => Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES,
      `must be at most ${MAX_SOCKET_PATH_BYTES} bytes`,
    ),
  /** Directory holding encoder, decoder, joiner and tokens of the model. */
  modelDir: z.string().min(1),
  /**
   * Silero VAD model. With it, audio is decoded one utterance at a time.
   * Without it, in chunks of up to 30 s.
   */
  vadModel: z.string().min(1).optional(),
  threads: z.coerce.number().int().min(1).max(64).default(4),
  /** Concurrent dictation sessions. Each one is a person talking. */
  maxSessions: z.coerce.number().int().min(1).max(64).default(4),
  /** Audio one session may send before it is stopped. */
  maxSeconds: z.coerce.number().int().min(10).max(3600).default(600),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    socket: env.STT_SOCKET || undefined,
    modelDir: env.STT_MODEL_DIR,
    vadModel: env.STT_VAD_MODEL || undefined,
    threads: env.STT_THREADS || undefined,
    maxSessions: env.STT_MAX_SESSIONS || undefined,
    maxSeconds: env.STT_MAX_SECONDS || undefined,
  });
}
