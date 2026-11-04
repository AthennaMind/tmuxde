import { z } from "zod";

export const FileRevision = z.string().regex(/^[a-f0-9]{64}$/);

export const FileDocumentSchema = z.object({
  content: z.string(),
  revision: FileRevision,
  writable: z.boolean(),
});

export type FileDocument = z.infer<typeof FileDocumentSchema>;
