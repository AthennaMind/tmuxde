import { z } from "zod";

/** Authenticated GET /machines response. Credentials never enter this schema. */
export const MachineInfoSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string(),
  online: z.boolean(),
  hostname: z.string(),
  platform: z.string(),
  defaultPath: z.string(),
  version: z.string(),
  features: z.array(z.string()),
});

export const MachineListSchema = z.array(MachineInfoSchema);
export type MachineInfo = z.infer<typeof MachineInfoSchema>;
