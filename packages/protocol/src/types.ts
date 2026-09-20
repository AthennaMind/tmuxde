import { z } from "zod";

export const TerminalSizeSchema = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500),
});
export type TerminalSize = z.infer<typeof TerminalSizeSchema>;

export const ConnectionState = {
  CONNECTING: "connecting",
  AUTHENTICATING: "authenticating",
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
  DISCONNECTED: "disconnected",
} as const;
export type ConnectionState =
  (typeof ConnectionState)[keyof typeof ConnectionState];

export const SessionInfoSchema = z.object({
  name: z.string(),
  id: z.string(),
  windows: z.number().int(),
  attached: z.boolean(),
  created: z.string(),
  activity: z.string(),
  dimensions: TerminalSizeSchema.optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const PaneInfoSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  windowId: z.string(),
  active: z.boolean(),
  zoomed: z.boolean(),
  dimensions: TerminalSizeSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  command: z.string().optional(),
  path: z.string().optional(),
});
export type PaneInfo = z.infer<typeof PaneInfoSchema>;

export const WindowInfoSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  name: z.string(),
  active: z.boolean(),
  paneCount: z.number().int(),
  layout: z.string(),
  /** tmux's `window_activity_flag`: output arrived while you were elsewhere. */
  activity: z.boolean().optional(),
  /**
   * tmux's `window_zoomed_flag` — is one of this window's panes filling it?
   *
   * On the window rather than on a pane because that is where tmux keeps it,
   * and because a window listing is the cheapest thing that can notice a zoom
   * toggled outside the client (`prefix z` in the user's own terminal). It
   * carries no pane id on purpose: which pane is zoomed is the active one, and
   * saying so twice invites the two to disagree.
   *
   * Optional, so a relay that predates it is read as "cannot say" rather than
   * as "not zoomed".
   */
  zoomed: z.boolean().optional(),
  dimensions: TerminalSizeSchema.optional(),
});
export type WindowInfo = z.infer<typeof WindowInfoSchema>;

export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory", "symlink", "other"]),
  size: z.number(),
  modified: z.string(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileStatSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory", "symlink", "other"]),
  size: z.number(),
  modified: z.string(),
  created: z.string(),
  permissions: z.string(),
  isReadable: z.boolean(),
  isWritable: z.boolean(),
});
export type FileStat = z.infer<typeof FileStatSchema>;
