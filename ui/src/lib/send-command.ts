import { getRelayClient } from "@/hooks/use-websocket";
import { useCommandStore } from "@/stores/command-store";
import { usePaneStore } from "@/stores/pane-store";
import { isShell } from "./shell-commands";

/**
 * The one way anything in this app sends a command to the terminal.
 *
 * There used to be four, and they disagreed in ways users felt:
 *
 * - The mobile bar sent `terminal:input`, which the relay drops on the floor
 *   when nothing is attached (`message-router.ts`). `command:send` replies
 *   `NOT_ATTACHED` instead, so a send that cannot land says so.
 * - The mobile bar never called `addToHistory`, so nothing typed on a phone was
 *   ever remembered — the palette's history was desktop-only by accident.
 * - The file tree and editor deliberately do *not* want their generated
 *   commands in history, which is a real distinction and now an argument
 *   rather than a copy of the function without the history line.
 *
 * Returns whether the command was handed to the socket, so a caller can decide
 * whether to clear its input.
 */
export type SendCommandOptions = {
  /** Add to the palette's history. Default true; false for generated commands. */
  record?: boolean;
};

export function sendCommand(
  text: string,
  { record = true }: SendCommandOptions = {},
): boolean {
  const command = text.trim();
  if (!command) return false;

  const client = getRelayClient();
  if (!client || client.status !== "connected") return false;

  client.send({ type: "command:send", command: forWire(command) });
  if (record) useCommandStore.getState().addToHistory(command);
  return true;
}

/**
 * Bracketed paste around anything multi-line, but only into a shell.
 *
 * Without it a three-line block is three commands: readline sees the first
 * newline and executes, so lines two and three run against whatever the first
 * one started. Wrapped, the whole block lands in the buffer as one command and
 * the trailing `\r` submits it — which is what someone who typed three lines in
 * the composer and pressed Send meant.
 *
 * Gated on the foreground process being a shell, because `vim` and friends have
 * no idea what `\x1b[200~` is and will helpfully type it into the document.
 * When we cannot tell what is in the foreground, the safe answer is "not a
 * shell": a literal escape sequence on screen is worse than a block that runs
 * line by line, which is at least what a paste has always done.
 */
function forWire(command: string): string {
  if (!command.includes("\n")) return command;
  return activePaneIsShell() ? `\x1b[200~${command}\x1b[201~\r` : command;
}

function activePaneIsShell(): boolean {
  const { panes, activePaneId } = usePaneStore.getState();
  const pane = panes.find((p) => p.id === activePaneId);
  return isShell(pane?.command);
}
