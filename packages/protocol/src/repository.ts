import { z } from "zod";
import { FileEntrySchema } from "./types";

export const RepoScope = z.enum(["unstaged", "staged", "untracked"]);
export const RepoRequest = z.object({
  type: z.literal("repo:request"),
  requestId: z.string().min(1).max(128),
  id: z.string().min(1),
  action: z.enum(["context", "list", "read", "status", "diff", "log", "show"]),
  path: z.string().optional(),
  file: z.string().optional(),
  scope: RepoScope.optional(),
  /** `log` only. Commits to pass over, for the next page. */
  skip: z.number().int().min(0).max(1_000_000).optional(),
  /** `show` only. Full or abbreviated commit hash. */
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
});
export type RepoRequest = z.infer<typeof RepoRequest>;

/** One commit in a `log` page. `date` is the author date in ISO 8601. */
export const RepoCommitSchema = z.object({
  hash: z.string(),
  parents: z.array(z.string()),
  author: z.string(),
  date: z.string(),
  subject: z.string(),
  /** Decorations as Git prints them: `HEAD -> main`, `origin/main`, `tag: v1`. */
  refs: z.array(z.string()),
});
export type RepoCommit = z.infer<typeof RepoCommitSchema>;

/**
 * One file of a commit's patch. `status` is the Git raw status letter.
 * Counts are null for binary files. `patch` is this file's section of the
 * patch, from `diff --git` on, and empty when output stopped before it.
 */
export const RepoCommitFileSchema = z.object({
  path: z.string(),
  originalPath: z.string().optional(),
  status: z.string(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  binary: z.boolean(),
  patch: z.string(),
});
export type RepoCommitFile = z.infer<typeof RepoCommitFileSchema>;

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
  z.object({
    kind: z.literal("log"),
    root: z.string().nullable(),
    branch: z.string().nullable(),
    skip: z.number(),
    commits: z.array(RepoCommitSchema),
    /** Older commits exist past this page. */
    more: z.boolean(),
  }),
  z.object({
    kind: z.literal("show"),
    root: z.string(),
    commit: RepoCommitSchema.extend({
      email: z.string(),
      committer: z.string(),
      committerDate: z.string(),
      body: z.string(),
    }),
    files: z.array(RepoCommitFileSchema),
    /** Files left out because file policy denies their path. */
    hidden: z.number(),
    truncated: z.boolean(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type RepoResult = z.infer<typeof RepoResult>;
export const RepoResponse = z.object({
  type: z.literal("repo:result"),
  requestId: z.string(),
  result: RepoResult,
});
