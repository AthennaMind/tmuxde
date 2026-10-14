/**
 * Foreground processes that are a shell, rather than something running in one.
 *
 * Two callers, and they want it for different reasons: pane labels read better
 * as a path when the process is just a shell, and a multi-line send is only
 * safe to wrap in bracketed paste when a shell is the thing reading it — `vim`
 * would take the wrapper literally and print `[200~` on screen.
 *
 * Shared rather than copied because the two must not drift: a shell missing
 * from one list is a cosmetic wart, and missing from the other is a mangled
 * buffer in someone's editor.
 */
export const SHELL_COMMANDS = new Set([
  "bash",
  "zsh",
  "fish",
  "sh",
  "dash",
  "ksh",
  "tcsh",
  "csh",
]);

export function isShell(command: string | undefined | null): boolean {
  return (
    command !== undefined && command !== null && SHELL_COMMANDS.has(command)
  );
}
