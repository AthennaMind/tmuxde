import { z } from "zod";

/**
 * Authenticated POST /file/ticket response. The ticket opens one file on
 * one machine through GET /file for `expiresIn` seconds, so a media
 * element can load it without the bearer header.
 */
export const FileTicketSchema = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]+$/),
  expiresIn: z.number().int().positive(),
});
