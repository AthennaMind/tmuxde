import { z } from "zod";

export const PreviewTarget = z.object({
  session: z.string().min(1).max(256),
  paneId: z.string().regex(/^%[0-9]+$/),
});
export type PreviewTarget = z.infer<typeof PreviewTarget>;
export const PreviewFrame = z.object({
  paneId: z.string().regex(/^%[0-9]+$/),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500),
  content: z.string().max(131072),
  unavailable: z.boolean(),
});
export type PreviewFrame = z.infer<typeof PreviewFrame>;
