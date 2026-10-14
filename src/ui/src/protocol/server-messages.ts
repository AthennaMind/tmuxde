import { z } from "zod";
import {
  RepoChangedMessage,
  RepoResponse,
  RepoWatchResultMessage,
} from "./repository";
import {
  SessionInfoSchema,
  FileEntrySchema,
  FileStatSchema,
  PaneInfoSchema,
  WindowInfoSchema,
} from "./types";

export const AuthSuccessMessage = z.object({
  type: z.literal("auth:success"),
  serverVersion: z.string(),
  /**
   * What this credential may do, so the UI can be honest about it.
   *
   * Strictly advisory. Every field here is enforced on the server for every
   * message regardless of what the client does with it — this exists so a
   * read-only viewer sees a read-only banner instead of a keyboard that
   * silently does nothing, and so a share with no file access does not render
   * a file tree that can only ever answer ACCESS_DENIED.
   *
   * Optional because an older relay does not send it, and the absence must
   * read as "unrestricted", which is what such a relay in fact is.
   */
  capabilities: z
    .object({
      readOnly: z.boolean(),
      files: z.enum(["none", "read", "write"]),
      /**
       * The grant's scope kind, as a plain string.
       *
       * Deliberately **not** a `z.enum`. This whole object is advisory —
       * everything in it is enforced server-side on every message regardless —
       * but it sits inside `auth:success`, so an unrecognised value would fail
       * the parse of the message that says the connection is up. The web app
       * ships ahead of the CLI on every user's machine, which means a relay
       * introducing a scope kind would hard-break every browser still on the
       * previous build. `features` was designed for that direction of drift;
       * this field has to tolerate it too.
       */
      scope: z.string(),
    })
    .optional(),

  /**
   * Message types this relay understands beyond the original set.
   *
   * A relay that does not know a message type answers `INVALID_MESSAGE`, which
   * from the browser is indistinguishable from a switch that silently did
   * nothing. The web app ships ahead of the CLI on every user's machine, so it
   * has to be able to ask before it uses something new.
   *
   * Absent means "an older relay" — treat every entry as unsupported and use
   * the pre-existing id-based equivalent. Advisory in the same sense as
   * `capabilities`: the relay still validates every message it receives.
   */
  features: z.array(z.string()).optional(),
});

export const AuthFailureMessage = z.object({
  type: z.literal("auth:failure"),
  reason: z.string(),
});

export const PongMessage = z.object({
  type: z.literal("pong"),
  timestamp: z.number(),
});

export const ErrorMessage = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const ServerInfoMessage = z.object({
  type: z.literal("server:info"),
  hostname: z.string(),
  platform: z.string(),
  uptime: z.number(),
  // Primary allowed directory the file browser should open to. Advertised by
  // the relay so the client doesn't have to guess the server's home path.
  defaultPath: z.string().optional(),
});

export const TerminalOutputMessage = z.object({
  type: z.literal("terminal:output"),
  data: z.string(),
});

export const SessionListResponse = z.object({
  type: z.literal("session:list"),
  sessions: z.array(SessionInfoSchema),
});

export const SessionCreatedMessage = z.object({
  type: z.literal("session:created"),
  session: SessionInfoSchema,
});

export const SessionKilledMessage = z.object({
  type: z.literal("session:killed"),
  name: z.string(),
});

export const SessionActivityMessage = z.object({
  type: z.literal("session:activity"),
  name: z.string(),
  activity: z.string(),
});

export const SessionExitedMessage = z.object({
  type: z.literal("session:exited"),
  name: z.string(),
  exitCode: z.number().optional(),
});

export const FileListResponse = z.object({
  type: z.literal("file:list"),
  path: z.string(),
  entries: z.array(FileEntrySchema),
});

export const FileContentResponse = z.object({
  type: z.literal("file:content"),
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

export const FileStatResponse = z.object({
  type: z.literal("file:stat"),
  stat: FileStatSchema,
});

export const FileChangedMessage = z.object({
  type: z.literal("file:changed"),
  path: z.string(),
  event: z.enum(["add", "change", "unlink", "addDir", "unlinkDir"]),
});

// File write/operation results
export const FileWriteResultMessage = z.object({
  type: z.literal("file:write:result"),
  path: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  size: z.number().optional(),
});

export const FileOpResultMessage = z.object({
  type: z.literal("file:op:result"),
  op: z.enum(["create", "mkdir", "delete", "rename", "upload"]),
  path: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  final: z.boolean().optional(),
});

// Pane/Window response messages
export const PaneListResponse = z.object({
  type: z.literal("pane:list"),
  panes: z.array(PaneInfoSchema),
  windowId: z.string(),
});

export const WindowListResponse = z.object({
  type: z.literal("window:list"),
  windows: z.array(WindowInfoSchema),
  sessionName: z.string(),
});

export const PaneChangedMessage = z.object({
  type: z.literal("pane:changed"),
  panes: z.array(PaneInfoSchema),
  windowId: z.string(),
});

export const WindowChangedMessage = z.object({
  type: z.literal("window:changed"),
  windows: z.array(WindowInfoSchema),
  sessionName: z.string(),
});

export const SessionAttachedMessage = z.object({
  type: z.literal("session:attached"),
  name: z.string(),
  // Echoes `session:attach.attachId` — see client-messages.ts.
  attachId: z.string().optional(),
});

export const PaneCapturedMessage = z.object({
  type: z.literal("pane:captured"),
  id: z.string(),
  content: z.string(),
});

/**
 * Where the attached pane's view sits inside tmux's history.
 *
 * The client cannot work this out for itself. `attachSession` runs a real
 * `tmux attach-session`, so tmux owns the alternate screen and xterm's own
 * buffer is empty — a browser scrollbar drawn from it would always be a full
 * thumb over nothing. These are the numbers tmux reports for the pane, and
 * they are what the terminal's scroll rail is drawn from.
 *
 * `position` is how many lines the view is scrolled back from the live output,
 * so 0 is the bottom. `historySize` is how many lines exist above the visible
 * `paneHeight` rows. `inMode` is `pane_in_mode`: outside copy mode tmux does
 * not publish a scroll position at all, and the honest answer there is "at the
 * bottom", not "unknown".
 */
export const TmuxScrollStateMessage = z.object({
  type: z.literal("tmux:scroll-state"),
  position: z.number().int().min(0),
  historySize: z.number().int().min(0),
  paneHeight: z.number().int().min(0),
  inMode: z.boolean(),
});

export const SessionWindowsResponse = z.object({
  type: z.literal("session:windows"),
  name: z.string(),
  windows: z.array(WindowInfoSchema),
  panes: z.array(PaneInfoSchema),
});

const DictationId = z.string().min(1).max(64);

/** The speech service is listening. Audio sent from now on is transcribed. */
export const DictationReadyMessage = z.object({
  type: z.literal("dictation:ready"),
  id: DictationId,
});

/**
 * Transcribed text, one message per decoded stretch of audio, in order.
 * Long dictation is cut at pauses, so text arrives while the user talks.
 * Carries no separator: the client decides spacing between pieces.
 */
export const DictationTextMessage = z.object({
  type: z.literal("dictation:text"),
  id: DictationId,
  text: z.string().max(20_000),
});

/** Everything after `dictation:stop` is transcribed. Nothing more follows. */
export const DictationDoneMessage = z.object({
  type: z.literal("dictation:done"),
  id: DictationId,
});

/**
 * The dictation ended without finishing. Nothing more follows.
 *
 * `code` is `UNAVAILABLE` (no speech service), `BUSY` (service at capacity),
 * `OVERLOADED` (audio arriving faster than it can be forwarded), `NOT_FOUND`
 * (audio or stop for a dictation that is not running) or `FAILED`.
 */
export const DictationErrorMessage = z.object({
  type: z.literal("dictation:error"),
  id: DictationId,
  code: z.string(),
  message: z.string(),
});

export const ServerMessage = z.discriminatedUnion("type", [
  RepoResponse,
  RepoWatchResultMessage,
  RepoChangedMessage,
  AuthSuccessMessage,
  AuthFailureMessage,
  PongMessage,
  ErrorMessage,
  ServerInfoMessage,
  TerminalOutputMessage,
  SessionListResponse,
  SessionCreatedMessage,
  SessionKilledMessage,
  SessionActivityMessage,
  SessionExitedMessage,
  FileListResponse,
  FileContentResponse,
  FileStatResponse,
  FileChangedMessage,
  FileWriteResultMessage,
  FileOpResultMessage,
  PaneListResponse,
  WindowListResponse,
  PaneChangedMessage,
  WindowChangedMessage,
  SessionAttachedMessage,
  PaneCapturedMessage,
  TmuxScrollStateMessage,
  SessionWindowsResponse,
  DictationReadyMessage,
  DictationTextMessage,
  DictationDoneMessage,
  DictationErrorMessage,
]);

export type ServerMessage = z.infer<typeof ServerMessage>;
export type AuthSuccessMessage = z.infer<typeof AuthSuccessMessage>;
export type AuthFailureMessage = z.infer<typeof AuthFailureMessage>;
export type PongMessage = z.infer<typeof PongMessage>;
export type ErrorMessage = z.infer<typeof ErrorMessage>;
export type ServerInfoMessage = z.infer<typeof ServerInfoMessage>;
export type TerminalOutputMessage = z.infer<typeof TerminalOutputMessage>;
export type SessionListResponse = z.infer<typeof SessionListResponse>;
export type SessionCreatedMessage = z.infer<typeof SessionCreatedMessage>;
export type SessionKilledMessage = z.infer<typeof SessionKilledMessage>;
export type SessionActivityMessage = z.infer<typeof SessionActivityMessage>;
export type SessionExitedMessage = z.infer<typeof SessionExitedMessage>;
export type FileListResponse = z.infer<typeof FileListResponse>;
export type FileContentResponse = z.infer<typeof FileContentResponse>;
export type FileStatResponse = z.infer<typeof FileStatResponse>;
export type FileChangedMessage = z.infer<typeof FileChangedMessage>;
export type FileWriteResultMessage = z.infer<typeof FileWriteResultMessage>;
export type FileOpResultMessage = z.infer<typeof FileOpResultMessage>;
export type PaneListResponse = z.infer<typeof PaneListResponse>;
export type WindowListResponse = z.infer<typeof WindowListResponse>;
export type PaneChangedMessage = z.infer<typeof PaneChangedMessage>;
export type WindowChangedMessage = z.infer<typeof WindowChangedMessage>;
export type SessionAttachedMessage = z.infer<typeof SessionAttachedMessage>;
export type PaneCapturedMessage = z.infer<typeof PaneCapturedMessage>;
export type TmuxScrollStateMessage = z.infer<typeof TmuxScrollStateMessage>;
export type SessionWindowsResponse = z.infer<typeof SessionWindowsResponse>;
export type DictationReadyMessage = z.infer<typeof DictationReadyMessage>;
export type DictationTextMessage = z.infer<typeof DictationTextMessage>;
export type DictationDoneMessage = z.infer<typeof DictationDoneMessage>;
export type DictationErrorMessage = z.infer<typeof DictationErrorMessage>;
