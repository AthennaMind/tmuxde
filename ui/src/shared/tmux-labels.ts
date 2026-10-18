import { isShell } from "./shell-commands";

/** Labels for sessions, windows and panes, shared by every list of them. */

export function isShellCommand(command?: string): boolean {
  return !command || isShell(command);
}

export function shortenPath(path: string): string {
  if (!path) return "";
  return path.replace(/^\/home\/[^/]+/, "~").replace(/^\/root/, "~");
}

/** Last `keep` segments of a shortened path, for narrow rows. */
export function tailPath(path: string, keep = 2): string {
  const short = shortenPath(path);
  const parts = short.split("/").filter(Boolean);
  if (parts.length <= keep) return short;
  return `…/${parts.slice(-keep).join("/")}`;
}

export function formatPaneName(command?: string, path?: string): string {
  if (isShellCommand(command)) {
    return path ? shortenPath(path) : command || "shell";
  }
  return path ? `${command} · ${shortenPath(path)}` : command!;
}

export function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
