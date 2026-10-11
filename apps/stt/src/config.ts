import { z } from "zod";

const ConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65535).default(24400),
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
    host: env.STT_HOST || undefined,
    port: env.STT_PORT || undefined,
    modelDir: env.STT_MODEL_DIR,
    vadModel: env.STT_VAD_MODEL || undefined,
    threads: env.STT_THREADS || undefined,
    maxSessions: env.STT_MAX_SESSIONS || undefined,
    maxSeconds: env.STT_MAX_SECONDS || undefined,
  });
}
