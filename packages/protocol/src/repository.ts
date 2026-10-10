import { z } from "zod";
import { FileEntrySchema } from "./types";

export const RepoScope = z.enum(["unstaged", "staged", "untracked"]);
export const RepoRequest = z.object({
  type: z.literal("repo:request"),
  requestId: z.string().min(1).max(128),
  id: z.string().min(1),
  action: z.enum(["context", "list", "read", "status", "diff"]),
  path: z.string().optional(),
  file: z.string().optional(),
  scope: RepoScope.optional(),
});
export type RepoRequest = z.infer<typeof RepoRequest>;

export const RepoResult = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("context"),
    path: z.string(),
    root: z.string().nullable(),
    branch: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("list"),
    path: z.string(),
    entries: z.array(FileEntrySchema),
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal("read"),
    path: z.string(),
    content: z.string(),
    truncated: z.boolean(),
    binary: z.boolean(),
  }),
  z.object({
    kind: z.literal("status"),
    root: z.string().nullable(),
    branch: z.string().nullable(),
    entries: z.array(
      z.object({
        path: z.string(),
        originalPath: z.string().optional(),
        index: z.string(),
        worktree: z.string(),
      }),
    ),
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal("diff"),
    path: z.string(),
    scope: RepoScope,
    content: z.string(),
    truncated: z.boolean(),
    binary: z.boolean(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type RepoResult = z.infer<typeof RepoResult>;
export const RepoResponse = z.object({
  type: z.literal("repo:result"),
  requestId: z.string(),
  result: RepoResult,
});
