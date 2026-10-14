import { z } from "zod";

// Relay WebSocket URL baked in at build time. Empty means same origin.
export const relayUrl: string = z
  .union([z.literal(""), z.string().url()])
  .default("")
  .parse(import.meta.env.VITE_RELAY_URL);
