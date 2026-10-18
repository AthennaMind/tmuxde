import type { PaneInfo } from "@/protocol";
import { isShellCommand, tailPath } from "@/shared/tmux-labels";

export type ProcessKind = "agent" | "code" | "server" | "git" | "terminal" | "process";

/** Labels describe what tmux reports, without guessing what a runtime hosts. */
export function processPresentation(command?: string): { label: string; kind: ProcessKind } {
  const name = command?.split("/").pop()?.replace(/^-/, "") ?? "";
  if (isShellCommand(name)) return { label: "Terminal", kind: "terminal" };
  if (name === "claude") return { label: "Claude Code", kind: "agent" };
  if (name === "codex") return { label: "Codex", kind: "agent" };
  if (name === "aider" || name === "opencode") return { label: name, kind: "agent" };
  if (name === "node" || name === "nodejs") return { label: "Node.js", kind: "server" };
  if (/^python[\d.]*$/.test(name)) return { label: "Python", kind: "code" };
  if (["bun", "deno", "go", "ruby", "uv"].includes(name)) return { label: name, kind: "code" };
  if (["vim", "nvim", "nano", "emacs"].includes(name)) return { label: name, kind: "code" };
  if (name === "git" || name === "lazygit") return { label: name, kind: "git" };
  return { label: name, kind: "process" };
}

/**
 * Window row text.
 *
 * `label` is the tmux window name when someone set it, else what runs.
 * tmux names a window after its shell or its command by itself, so those
 * names repeat the panes and say nothing new. A number is a default too.
 */
export function windowPresentation(name: string, panes: PaneInfo[]) {
  const running = [
    ...new Set(
      panes
        .map((pane) => processPresentation(pane.command))
        .filter((process) => process.kind !== "terminal")
        .map((process) => process.label),
    ),
  ];
  const processes = running.length ? running.join(" + ") : undefined;
  const paths = [...new Set(panes.map((pane) => pane.path).filter(Boolean))];
  const folder =
    paths.length === 1 ? tailPath(paths[0]!) : paths.length ? `${paths.length} folders` : undefined;
  const custom =
    !isShellCommand(name) && !panes.some((pane) => pane.command === name) && !/^\d+$/.test(name);
  return {
    label: custom ? name : (processes ?? "Terminal"),
    /** Running processes other than shells, such as "Claude Code + top". */
    processes,
    /** One folder as a short path, or how many there are. */
    folder,
    custom,
  };
}

export interface PaneRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** tmux's saved layout keeps original splits even while a pane is zoomed. */
export function paneLayout(layout: string, panes: PaneInfo[]): PaneRect[] {
  const leaves = [...layout.matchAll(/(\d+)x(\d+),(\d+),(\d+),(\d+)(?=[,\]}]|$)/g)];
  const parsed = leaves
    .map((match) => ({
      id: `%${match[5]}`,
      x: Number(match[3]),
      y: Number(match[4]),
      width: Number(match[1]),
      height: Number(match[2]),
    }))
    .filter((rect) => panes.some((pane) => pane.id === rect.id));
  const rects =
    parsed.length === panes.length
      ? parsed
      : panes.map((pane) => ({
          id: pane.id,
          x: pane.position.x,
          y: pane.position.y,
          width: pane.dimensions.cols,
          height: pane.dimensions.rows,
        }));
  const width = Math.max(1, ...rects.map((rect) => rect.x + rect.width));
  const height = Math.max(1, ...rects.map((rect) => rect.y + rect.height));
  return rects.map((rect) => ({
    id: rect.id,
    x: rect.x / width,
    y: rect.y / height,
    width: rect.width / width,
    height: rect.height / height,
  }));
}
