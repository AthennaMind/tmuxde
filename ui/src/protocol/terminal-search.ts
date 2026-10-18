import { z } from "zod";

export const TerminalSearchMatch = z.object({
  sessionName: z.string(),
  windowId: z.string(),
  paneId: z.string(),
  command: z.string(),
  path: z.string(),
  line: z.number().int().min(1),
  text: z.string(),
  before: z.string(),
  after: z.string(),
});

export type TerminalSearchMatch = z.infer<typeof TerminalSearchMatch>;
