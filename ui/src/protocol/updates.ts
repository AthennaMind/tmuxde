import { z } from "zod";

export const UpdateComponentSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(["server", "agent", "speech"]),
  version: z.string(),
  os: z.string(),
  arch: z.string(),
  reason: z.string(),
  online: z.boolean(),
  eligible: z.boolean(),
  available: z.string(),
  size: z.number().int().nonnegative(),
});

const AssetSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  size: z.number().int().positive(),
  browser_download_url: z.url(),
  digest: z.string(),
});

const SnapshotSchema = z.object({
  id: z.string(),
  checked: z.iso.datetime(),
  release: z.object({
    id: z.number().int().positive(),
    tag_name: z.string(),
    html_url: z.url(),
    published_at: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(AssetSchema),
  }),
});

const ResultSchema = z.object({
  phase: z.enum([
    "pending",
    "downloading",
    "verifying",
    "staged",
    "starting",
    "installing",
    "restarting",
    "rolling-back",
    "awaiting-reconnect",
    "updated",
    "failed",
    "rolled-back",
    "rollback-failed",
    "cancelled",
    "interrupted",
  ]),
  message: z.string(),
});

export const UpdateJobSchema = z.object({
  id: z.string(),
  snapshot: z.string(),
  version: z.string(),
  created: z.iso.datetime(),
  active: z.boolean(),
  items: z.array(
    z.object({
      component: UpdateComponentSchema,
      transaction: z.string(),
      result: ResultSchema,
    }),
  ),
});

export const UpdateStatusSchema = z.object({
  components: z.array(UpdateComponentSchema),
  snapshot: SnapshotSchema.nullable(),
  job: UpdateJobSchema.nullable(),
});

const UpdateIDSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

export const StartUpdateSchema = z
  .object({
    id: UpdateIDSchema,
    snapshot: UpdateIDSchema,
    targets: z.array(UpdateIDSchema).min(1).max(64),
  })
  .strict()
  .refine((value) => new Set(value.targets).size === value.targets.length, {
    message: "Duplicate component selection",
    path: ["targets"],
  });

export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
export type UpdateJob = z.infer<typeof UpdateJobSchema>;
export type UpdateComponent = z.infer<typeof UpdateComponentSchema>;
