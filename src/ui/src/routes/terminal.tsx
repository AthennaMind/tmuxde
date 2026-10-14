import { TerminalWorkspace } from "@/components/terminal/terminal-workspace";

/**
 * The terminal. Sign-in and the session list hand off to this route, so it
 * stays at `/`.
 */
export function TerminalPage() {
  return <TerminalWorkspace />;
}
