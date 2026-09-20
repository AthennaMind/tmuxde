import { z } from "zod";
import { RecordingId, RecordingTarget } from "./recordings";
import { TerminalSizeSchema } from "./types";

export const AuthMessage = z.object({
  type: z.literal("auth"),
  token: z.string(),
});

export const PingMessage = z.object({
  type: z.literal("ping"),
  timestamp: z.number(),
});

export const TerminalInputMessage = z.object({
  type: z.literal("terminal:input"),
  data: z.string(),
});

export const TerminalResizeMessage = z.object({
  type: z.literal("terminal:resize"),
  size: TerminalSizeSchema,
});

export const SessionListMessage = z.object({
  type: z.literal("session:list"),
});

export const SessionCreateMessage = z.object({
  type: z.literal("session:create"),
  name: z.string().optional(),
  cwd: z.string().optional(),
  command: z.string().optional(),
});

export const SessionAttachMessage = z.object({
  type: z.literal("session:attach"),
  name: z.string(),
  size: TerminalSizeSchema.optional(),
  capture: z.boolean().optional(),
  // Attach epoch. Echoed back on `session:attached` so the client can reject
  // acks from a superseded attach instead of letting a stale one corrupt its
  // state machine. Optional so older clients/relays stay compatible.
  attachId: z.string().optional(),
});

export const SessionDetachMessage = z.object({
  type: z.literal("session:detach"),
});

export const SessionKillMessage = z.object({
  type: z.literal("session:kill"),
  name: z.string(),
});

export const SessionRenameMessage = z.object({
  type: z.literal("session:rename"),
  oldName: z.string(),
  newName: z.string(),
});

export const FileListMessage = z.object({
  type: z.literal("file:list"),
  path: z.string(),
});

export const FileReadMessage = z.object({
  type: z.literal("file:read"),
  path: z.string(),
});

export const FileStatMessage = z.object({
  type: z.literal("file:stat"),
  path: z.string(),
});

export const FileWatchMessage = z.object({
  type: z.literal("file:watch"),
  path: z.string(),
});

export const FileUnwatchMessage = z.object({
  type: z.literal("file:unwatch"),
  path: z.string(),
});

export const CommandSendMessage = z.object({
  type: z.literal("command:send"),
  command: z.string(),
});

export const CommandInterruptMessage = z.object({
  type: z.literal("command:interrupt"),
});

export const CommandEofMessage = z.object({
  type: z.literal("command:eof"),
});

export const CommandClearMessage = z.object({
  type: z.literal("command:clear"),
});

export const CommandSuspendMessage = z.object({
  type: z.literal("command:suspend"),
});

// File write/management messages
export const FileWriteMessage = z.object({
  type: z.literal("file:write"),
  path: z.string(),
  content: z.string(),
});

export const FileCreateMessage = z.object({
  type: z.literal("file:create"),
  path: z.string(),
  content: z.string().optional(),
});

export const FileMkdirMessage = z.object({
  type: z.literal("file:mkdir"),
  path: z.string(),
});

export const FileDeleteMessage = z.object({
  type: z.literal("file:delete"),
  path: z.string(),
});

export const FileRenameMessage = z.object({
  type: z.literal("file:rename"),
  oldPath: z.string(),
  newPath: z.string(),
});

export const FileUploadMessage = z.object({
  type: z.literal("file:upload"),
  path: z.string(),
  content: z.string(), // base64
  final: z.boolean(),
});

// Pane messages
export const PaneListMessage = z.object({
  type: z.literal("pane:list"),
});

export const PaneSplitMessage = z.object({
  type: z.literal("pane:split"),
  direction: z.enum(["h", "v"]),
});

export const PaneSelectMessage = z.object({
  type: z.literal("pane:select"),
  id: z.string(),
});

export const PaneZoomMessage = z.object({
  type: z.literal("pane:zoom"),
});

/**
 * Move to the next/previous pane of the *current* window.
 *
 * Relative rather than by id on purpose: the client's pane list can be a
 * moment stale, and tmux's own `:.+` / `:.-` targets cannot miss.
 */
export const PaneStepMessage = z.object({
  type: z.literal("pane:step"),
  delta: z.number().int(),
});

export const PaneResizeMessage = z.object({
  type: z.literal("pane:resize"),
  id: z.string(),
  direction: z.enum(["U", "D", "L", "R"]),
  amount: z.number().int().min(1),
});

export const PaneKillMessage = z.object({
  type: z.literal("pane:kill"),
  id: z.string(),
});

// Window messages
export const WindowListMessage = z.object({
  type: z.literal("window:list"),
});

export const WindowCreateMessage = z.object({
  type: z.literal("window:create"),
  name: z.string().optional(),
});

export const WindowSelectMessage = z.object({
  type: z.literal("window:select"),
  id: z.string(),
});

/** Move to the next/previous window, wrapping. See `PaneStepMessage`. */
export const WindowStepMessage = z.object({
  type: z.literal("window:step"),
  delta: z.number().int(),
});

export const WindowKillMessage = z.object({
  type: z.literal("window:kill"),
  id: z.string(),
});

export const PaneSwapMessage = z.object({
  type: z.literal("pane:swap"),
  id: z.string(),
  direction: z.enum(["U", "D", "L", "R"]),
});

export const WindowRenameMessage = z.object({
  type: z.literal("window:rename"),
  id: z.string(),
  name: z.string(),
});

export const WindowLayoutMessage = z.object({
  type: z.literal("window:layout"),
  preset: z.enum([
    "even-horizontal",
    "even-vertical",
    "main-horizontal",
    "main-vertical",
    "tiled",
  ]),
});

export const LayoutRotateMessage = z.object({
  type: z.literal("layout:rotate"),
});

export const TmuxPrefixMessage = z.object({
  type: z.literal("tmux:prefix"),
});

export const TmuxCopyModeMessage = z.object({
  type: z.literal("tmux:copy-mode"),
});

/**
 * Scroll the pane's history, in lines. Positive is back into the past.
 *
 * A server-side operation because there is nothing to scroll on the client:
 * the relay runs a real `tmux attach-session`, so tmux holds the alternate
 * screen and xterm's own scrollback buffer is permanently empty. The history
 * the user wants is tmux's, and copy-mode is the only way to reach it.
 *
 * Bounded so one message cannot ask tmux to walk an unbounded history, and so
 * a client bug cannot turn a flick into a hang.
 */
export const TmuxScrollMessage = z.object({
  type: z.literal("tmux:scroll"),
  lines: z.number().int().min(-500).max(500),
});

/**
 * Jump the view to an absolute point in the pane's history.
 *
 * `position` counts lines back from the live output, matching tmux's
 * `scroll_position`, so 0 means the bottom. This is what a scrollbar thumb
 * needs: a drag names a place in the history, not a number of lines to travel,
 * and deriving the delta on the client would race every line of output that
 * arrives mid-drag. The relay reads the pane's current position and moves the
 * difference.
 */
export const TmuxScrollToMessage = z.object({
  type: z.literal("tmux:scroll-to"),
  position: z.number().int().min(0),
});

/** Ask for the attached pane's scroll position — see `tmux:scroll-state`. */
export const TmuxScrollStateRequest = z.object({
  type: z.literal("tmux:scroll-state"),
});

/**
 * Leave copy mode, returning the pane to live output.
 *
 * Explicit rather than inferred from a scroll back to the bottom: tmux stays
 * in copy mode at the bottom of the history, where keystrokes are copy-mode
 * commands rather than input, and a user who has finished scrolling expects to
 * be able to type.
 */
export const TmuxExitCopyModeMessage = z.object({
  type: z.literal("tmux:exit-copy-mode"),
});

export const PaneCaptureMessage = z.object({
  type: z.literal("pane:capture"),
  id: z.string(),
});

export const SessionWindowsMessage = z.object({
  type: z.literal("session:windows"),
  name: z.string(),
});

/**
 * Recording control.
 *
 * Five messages that ship as a unit — `wire-connections.ts` advertises them
 * under the single `recording` feature flag, because a client that can list
 * recordings but not fetch one has nothing useful to offer.
 */
export const RecordingStartMessage = z.object({
  type: z.literal("recording:start"),
  target: RecordingTarget,
  /** Overrides the session name in the cast header. */
  title: z.string().max(256).optional(),
});

export const RecordingStopMessage = z.object({
  type: z.literal("recording:stop"),
  id: RecordingId,
});

export const RecordingListMessage = z.object({
  type: z.literal("recording:list"),
});

export const RecordingDeleteMessage = z.object({
  type: z.literal("recording:delete"),
  id: RecordingId,
});

/**
 * Ask for a recording's bytes, streamed back as `recording:chunk`.
 *
 * Over the websocket rather than over HTTP, and that is not a preference. The
 * phone-on-cellular case is a *tunnelled* session: the relay is reachable only
 * as sealed frames through the broker, and `resolveRelayHttpBase()` in the web
 * app returns `""` for exactly that reason. An HTTP transport would work on a
 * LAN and fail for the case the feature exists to serve.
 *
 * `offset` resumes an interrupted transfer without re-sending what arrived.
 */
export const RecordingFetchMessage = z.object({
  type: z.literal("recording:fetch"),
  id: RecordingId,
  offset: z.number().int().nonnegative().default(0),
});

/**
 * The human's answer to `device:approval-request`.
 *
 * `approved` is a boolean and not an enum of one value, because a denial has
 * to be sendable: a browser that says no must be able to say it *now*, rather
 * than closing the dialog and leaving the requester to sit out the timeout.
 * Silence still denies — that is what the timeout is for — but an explicit no
 * is faster and kinder, and it is the answer people actually give.
 *
 * Restricted to full-grant connections by `POLICY`. A read-only share that
 * could admit devices would be a share that could grant more than it holds.
 */
export const DeviceApproveMessage = z.object({
  type: z.literal("device:approve"),
  id: z.string().min(1).max(64),
  approved: z.boolean(),
});

export const ClientMessage = z.discriminatedUnion("type", [
  AuthMessage,
  PingMessage,
  TerminalInputMessage,
  TerminalResizeMessage,
  SessionListMessage,
  SessionCreateMessage,
  SessionAttachMessage,
  SessionDetachMessage,
  SessionKillMessage,
  SessionRenameMessage,
  FileListMessage,
  FileReadMessage,
  FileStatMessage,
  FileWatchMessage,
  FileUnwatchMessage,
  FileWriteMessage,
  FileCreateMessage,
  FileMkdirMessage,
  FileDeleteMessage,
  FileRenameMessage,
  FileUploadMessage,
  CommandSendMessage,
  CommandInterruptMessage,
  CommandEofMessage,
  CommandClearMessage,
  CommandSuspendMessage,
  PaneListMessage,
  PaneSplitMessage,
  PaneSelectMessage,
  PaneZoomMessage,
  PaneStepMessage,
  PaneResizeMessage,
  PaneKillMessage,
  WindowListMessage,
  WindowCreateMessage,
  WindowSelectMessage,
  WindowStepMessage,
  WindowKillMessage,
  PaneSwapMessage,
  WindowRenameMessage,
  WindowLayoutMessage,
  LayoutRotateMessage,
  TmuxPrefixMessage,
  TmuxCopyModeMessage,
  TmuxScrollMessage,
  TmuxScrollToMessage,
  TmuxScrollStateRequest,
  TmuxExitCopyModeMessage,
  PaneCaptureMessage,
  SessionWindowsMessage,
  RecordingStartMessage,
  RecordingStopMessage,
  RecordingListMessage,
  RecordingDeleteMessage,
  RecordingFetchMessage,
  DeviceApproveMessage,
]);

export type ClientMessage = z.infer<typeof ClientMessage>;
export type AuthMessage = z.infer<typeof AuthMessage>;
export type PingMessage = z.infer<typeof PingMessage>;
export type TerminalInputMessage = z.infer<typeof TerminalInputMessage>;
export type TerminalResizeMessage = z.infer<typeof TerminalResizeMessage>;
export type SessionListMessage = z.infer<typeof SessionListMessage>;
export type SessionCreateMessage = z.infer<typeof SessionCreateMessage>;
export type SessionAttachMessage = z.infer<typeof SessionAttachMessage>;
export type SessionDetachMessage = z.infer<typeof SessionDetachMessage>;
export type SessionKillMessage = z.infer<typeof SessionKillMessage>;
export type SessionRenameMessage = z.infer<typeof SessionRenameMessage>;
export type FileListMessage = z.infer<typeof FileListMessage>;
export type FileReadMessage = z.infer<typeof FileReadMessage>;
export type FileStatMessage = z.infer<typeof FileStatMessage>;
export type FileWatchMessage = z.infer<typeof FileWatchMessage>;
export type FileUnwatchMessage = z.infer<typeof FileUnwatchMessage>;
export type FileWriteMessage = z.infer<typeof FileWriteMessage>;
export type FileCreateMessage = z.infer<typeof FileCreateMessage>;
export type FileMkdirMessage = z.infer<typeof FileMkdirMessage>;
export type FileDeleteMessage = z.infer<typeof FileDeleteMessage>;
export type FileRenameMessage = z.infer<typeof FileRenameMessage>;
export type FileUploadMessage = z.infer<typeof FileUploadMessage>;
export type CommandSendMessage = z.infer<typeof CommandSendMessage>;
export type CommandInterruptMessage = z.infer<typeof CommandInterruptMessage>;
export type CommandEofMessage = z.infer<typeof CommandEofMessage>;
export type CommandClearMessage = z.infer<typeof CommandClearMessage>;
export type CommandSuspendMessage = z.infer<typeof CommandSuspendMessage>;
export type PaneListMessage = z.infer<typeof PaneListMessage>;
export type PaneSplitMessage = z.infer<typeof PaneSplitMessage>;
export type PaneSelectMessage = z.infer<typeof PaneSelectMessage>;
export type PaneZoomMessage = z.infer<typeof PaneZoomMessage>;
export type PaneStepMessage = z.infer<typeof PaneStepMessage>;
export type PaneResizeMessage = z.infer<typeof PaneResizeMessage>;
export type PaneKillMessage = z.infer<typeof PaneKillMessage>;
export type WindowListMessage = z.infer<typeof WindowListMessage>;
export type WindowCreateMessage = z.infer<typeof WindowCreateMessage>;
export type WindowSelectMessage = z.infer<typeof WindowSelectMessage>;
export type WindowStepMessage = z.infer<typeof WindowStepMessage>;
export type WindowKillMessage = z.infer<typeof WindowKillMessage>;
export type PaneSwapMessage = z.infer<typeof PaneSwapMessage>;
export type WindowRenameMessage = z.infer<typeof WindowRenameMessage>;
export type WindowLayoutMessage = z.infer<typeof WindowLayoutMessage>;
export type LayoutRotateMessage = z.infer<typeof LayoutRotateMessage>;
export type TmuxPrefixMessage = z.infer<typeof TmuxPrefixMessage>;
export type TmuxCopyModeMessage = z.infer<typeof TmuxCopyModeMessage>;
export type TmuxScrollMessage = z.infer<typeof TmuxScrollMessage>;
export type TmuxScrollToMessage = z.infer<typeof TmuxScrollToMessage>;
export type TmuxScrollStateRequest = z.infer<typeof TmuxScrollStateRequest>;
export type TmuxExitCopyModeMessage = z.infer<typeof TmuxExitCopyModeMessage>;
export type PaneCaptureMessage = z.infer<typeof PaneCaptureMessage>;
export type SessionWindowsMessage = z.infer<typeof SessionWindowsMessage>;
export type RecordingStartMessage = z.infer<typeof RecordingStartMessage>;
export type RecordingStopMessage = z.infer<typeof RecordingStopMessage>;
export type RecordingListMessage = z.infer<typeof RecordingListMessage>;
export type RecordingDeleteMessage = z.infer<typeof RecordingDeleteMessage>;
export type RecordingFetchMessage = z.infer<typeof RecordingFetchMessage>;
export type DeviceApproveMessage = z.infer<typeof DeviceApproveMessage>;
