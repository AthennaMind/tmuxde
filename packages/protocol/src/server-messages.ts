import { z } from "zod";
import { RecordingId, RecordingInfo, RecordingStopReason } from "./recordings";
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
  /**
   * Why it failed, in a form a client may branch on.
   *
   * The difference this exists to carry is the difference between "your
   * credential is dead" and "nobody said yes". The browser's answer to an
   * auth failure is to wipe the stored token and the session keys and bounce
   * to `/start` — correct for a token the machine has forgotten, and
   * catastrophic for a connection that was merely not approved, which would
   * destroy a working pairing every time somebody was slow to answer.
   *
   * `unapproved` means the credential was fine and the human was not asked,
   * said no, or never answered. Nothing is stored about it; trying again
   * simply asks again. Optional so an older client — which cannot branch on
   * it anyway — keeps parsing the message.
   */
  code: z.enum(["unapproved"]).optional(),
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

/**
 * Another device just paired with this machine.
 *
 * A security signal, and a cheap one. Everything else about pairing is visible
 * only on the machine's own screen, so a browser already holding a session had
 * no way to learn that a second device had been let in — which is exactly the
 * event a user would want to hear about and exactly the one an attacker would
 * want kept quiet.
 *
 * Deliberately carries no token, no key and no descriptor: it is a notice, and
 * everything it names is already visible in `mtmux devices`.
 */
export const DevicePairedMessage = z.object({
  type: z.literal("device:paired"),
  /** Coarse, e.g. "Chrome on iOS". Never a full user-agent. */
  label: z.string().max(128),
  /** How the device got in, so the notice can say something true. */
  via: z.enum(["code", "request"]),
  at: z.number().int().positive(),
});

/**
 * A browser somewhere is asking to be let onto this machine. Decide.
 *
 * The one message in the protocol that is a *question*, and the only one whose
 * absence of an answer means something. It carries exactly what a human needs
 * to answer it and nothing that would help anyone who should not be answering
 * it: a coarse device label, the account that asked, and the six-digit SAS to
 * compare against what that browser is showing on its own screen.
 *
 * The SAS is not a secret and this is not a leak. It is a *comparison* value
 * derived from a key exchange that has already happened; knowing it lets you
 * confirm a pairing you are already being asked about, and nothing else. It
 * goes only to connections holding the full grant — see `POLICY` for the other
 * half of that rule — because a read-only share must not be able to widen
 * itself into "I can admit new devices".
 *
 * `expiresAt` is the wall clock the request dies at, so a tab that was in the
 * background can tell a live question from a stale one without asking.
 */
export const DeviceApprovalRequestMessage = z.object({
  type: z.literal("device:approval-request"),
  /** Opaque, server-minted. Echoed back in `device:approve`. */
  id: z.string().min(1).max(64),
  /** Coarse, e.g. "Chrome on iOS". Never a full user-agent. */
  deviceLabel: z.string().max(128),
  /** The account that pressed the button, or "" when anonymous. */
  accountEmail: z.string().max(254),
  /**
   * Six digits to compare against the requesting browser's own screen.
   *
   * Absent for a code pairing, and that absence is meaningful rather than
   * missing data: the nine-digit code *was* the shared secret, so there is
   * nothing left to compare and showing digits nobody can check would teach
   * people to wave through the ones that do matter. The question in that case
   * is "did you just type this code?", not "do these match?".
   */
  sas: z.string().max(16).optional(),
  /**
   * How the device is asking, so the dialog can pose the right question.
   *
   * `returning` is not a pairing at all: the device already proved itself
   * cryptographically and what is being asked is a policy question — "let this
   * one back in?" — which reads very differently from "someone just typed your
   * code". Dressing the two up as the same question is how people learn to
   * answer both without reading either.
   */
  via: z.enum(["code", "request", "returning"]).default("request"),
  expiresAt: z.number().int().positive(),
});

/**
 * That question is closed — stop asking.
 *
 * Fans out to every connection that was shown the request, including the one
 * that answered it, so a second phone's dialog closes itself rather than
 * sitting there offering a decision that can no longer be made. `approved`
 * reports what actually happened so the notice can say something true.
 */
export const DeviceApprovalResolvedMessage = z.object({
  type: z.literal("device:approval-resolved"),
  id: z.string().min(1).max(64),
  approved: z.boolean(),
  /**
   * How it ended. `expired` and `withdrawn` are both "nobody said yes", and
   * they are distinguished because only one of them is the human's fault.
   */
  reason: z.enum(["decided", "expired", "withdrawn"]),
});

export const RecordingStartedMessage = z.object({
  type: z.literal("recording:started"),
  recording: RecordingInfo,
});

export const RecordingStoppedMessage = z.object({
  type: z.literal("recording:stopped"),
  recording: RecordingInfo,
  reason: RecordingStopReason,
});

export const RecordingListResponse = z.object({
  type: z.literal("recording:list"),
  recordings: z.array(RecordingInfo),
});

export const RecordingDeletedMessage = z.object({
  type: z.literal("recording:deleted"),
  id: RecordingId,
});

/**
 * One slice of a recording's bytes, in reply to `recording:fetch`.
 *
 * `offset` is the byte position this chunk starts at, so a client can reassemble
 * out of order and detect a hole rather than silently concatenating a corrupt
 * file. `final` marks the last chunk; there is exactly one per transfer.
 */
export const RecordingChunkMessage = z.object({
  type: z.literal("recording:chunk"),
  id: RecordingId,
  offset: z.number().int().nonnegative(),
  /** Base64. The frame codec is happier with text and this mirrors `file:upload`. */
  data: z.string(),
  /** Total bytes in the recording, so a client can size its progress bar. */
  totalBytes: z.number().int().nonnegative(),
  final: z.boolean(),
});

export const ServerMessage = z.discriminatedUnion("type", [
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
  DevicePairedMessage,
  DeviceApprovalRequestMessage,
  DeviceApprovalResolvedMessage,
  RecordingStartedMessage,
  RecordingStoppedMessage,
  RecordingListResponse,
  RecordingDeletedMessage,
  RecordingChunkMessage,
]);

export type ServerMessage = z.infer<typeof ServerMessage>;
export type DevicePairedMessage = z.infer<typeof DevicePairedMessage>;
export type DeviceApprovalRequestMessage = z.infer<
  typeof DeviceApprovalRequestMessage
>;
export type DeviceApprovalResolvedMessage = z.infer<
  typeof DeviceApprovalResolvedMessage
>;
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
export type RecordingStartedMessage = z.infer<typeof RecordingStartedMessage>;
export type RecordingStoppedMessage = z.infer<typeof RecordingStoppedMessage>;
export type RecordingListResponse = z.infer<typeof RecordingListResponse>;
export type RecordingDeletedMessage = z.infer<typeof RecordingDeletedMessage>;
export type RecordingChunkMessage = z.infer<typeof RecordingChunkMessage>;
