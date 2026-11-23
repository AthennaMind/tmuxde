import type { ILinkProvider, Terminal } from "@xterm/xterm";
import type { PaneInfo } from "@/protocol";

export interface FileLinkContext {
  machineId: string;
  sessionName: string;
  panes: PaneInfo[];
}

export interface FileLinkTarget {
  machineId: string;
  sessionName: string;
  paneId: string;
  path: string;
  relativePath?: string;
  position?: { line: number; column: number; endColumn: number; requestId: string };
}

/** Recognize printed paths without interpreting shell syntax or running commands. */
export function findFilePaths(text: string) {
  const matches: { text: string; path: string; index: number; line?: number; column?: number }[] =
    [];
  const tokens =
    /"[^"\n]+"(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?|'[^'\n]+'(?::\d+(?::\d+)?)?|`[^`\n]+`(?::\d+(?::\d+)?)?|[^\s<>"'`|{},;]+/gu;
  for (const token of text.matchAll(tokens)) {
    let value = token[0];
    const quoted = /^["'`]/.test(value);
    let index = token.index;
    if (!quoted) {
      const leading = /^[([]+/.exec(value)?.[0].length ?? 0;
      index += leading;
      value = value.slice(leading);
      if (value.includes("…") || /\.{3}[)\].:!]*$/.test(value)) continue;
      value = value.replace(/[.:!]+$/, "");
      for (const [open, close] of [
        ["(", ")"],
        ["[", "]"],
      ]) {
        while (value.endsWith(close!) && value.split(close!).length > value.split(open!).length)
          value = value.slice(0, -1);
      }
      if (value.includes("…") || value.endsWith("...")) continue;
      value = value.replace(/[.:!]+$/, "");
    }
    const label = value;
    if (quoted) {
      const end = value.indexOf(value[0]!, 1);
      value = value.slice(1, end) + value.slice(end + 1);
    }
    if (!value || /:\/\/|^~|^--?|^\$/.test(value) || (!quoted && /[=*?]/.test(value))) continue;
    const location = /^(.*?)(?::([1-9]\d*)(?::([1-9]\d*))?|#L([1-9]\d*)(?:C([1-9]\d*))?)$/.exec(
      value,
    );
    const path = location?.[1] ?? value;
    if (
      (!quoted && path.includes(":")) ||
      (!quoted &&
        !path.includes("/") &&
        !/^(?:Makefile|Dockerfile|Containerfile|LICENSE|README|Justfile|Gemfile|Procfile|\.[\p{L}_][\p{L}\p{N}_.-]*|[\p{L}\p{N}_][\p{L}\p{N}_.-]*\.[\p{L}][\p{L}\p{N}]*)$/u.test(
          path,
        ))
    )
      continue;
    const line = location ? Number(location[2] ?? location[4]) : undefined;
    const column = location ? Number(location[3] ?? location[5] ?? 1) : undefined;
    if (
      line !== undefined &&
      (!Number.isSafeInteger(line) || line > 2_147_483_647 || column! > 2_147_483_647)
    )
      continue;
    matches.push({ text: label, path, index, ...(line ? { line, column } : {}) });
  }
  return matches;
}

export function fileLinkProvider(
  terminal: Terminal,
  context: () => FileLinkContext | null,
  open: (target: FileLinkTarget) => void,
): ILinkProvider {
  return {
    provideLinks(row, callback) {
      const origin = context();
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(row - 1);
      if (!origin || !line) return callback(undefined);
      const y = row - 1 - buffer.baseY;
      const zoomed = origin.panes.find((pane) => pane.zoomed);
      const panes = zoomed ? [zoomed] : origin.panes;
      const links = panes.flatMap((pane) => {
        const full = !!zoomed || panes.length === 1;
        if (!full && (y < pane.position.y || y >= pane.position.y + pane.dimensions.rows))
          return [];
        const left = full ? 0 : pane.position.x;
        const right = full ? terminal.cols : left + pane.dimensions.cols;
        let text = "";
        const cells: { x: number; y: number; width: number }[] = [];
        let startRow = row - 1;
        let endRow = row - 1;
        // Only xterm soft wraps are safe to join. TUI hard wraps carry no path metadata.
        if (full) {
          while (startRow > 0 && buffer.getLine(startRow)?.isWrapped && row - startRow < 64)
            startRow--;
          if (buffer.getLine(startRow)?.isWrapped) return [];
          while (buffer.getLine(endRow + 1)?.isWrapped && endRow - startRow < 64) endRow++;
          if (buffer.getLine(endRow + 1)?.isWrapped) return [];
        }
        for (let r = startRow; r <= endRow; r++) {
          const bufferLine = buffer.getLine(r);
          if (!bufferLine) continue;
          for (let x = left; x < right; x++) {
            const cell = bufferLine.getCell(x);
            if (!cell || cell.getWidth() === 0) continue;
            const chars = cell.getChars() || " ";
            for (let i = 0; i < chars.length; i++)
              cells.push({ x: x + 1, y: r + 1, width: cell.getWidth() });
            text += chars;
          }
        }
        return findFilePaths(text).flatMap((match) => {
          if (!match.path.startsWith("/") && !pane.path) return [];
          const start = cells[match.index];
          const end = cells[match.index + match.text.length - 1];
          if (!start || !end || row < start.y || row > end.y) return [];
          const target: FileLinkTarget = {
            machineId: origin.machineId,
            sessionName: origin.sessionName,
            paneId: pane.id,
            path: match.path.startsWith("/")
              ? match.path
              : `${pane.path!.replace(/\/$/, "")}/${match.path}`,
            ...(!match.path.startsWith("/") ? { relativePath: match.path } : {}),
            ...(match.line
              ? {
                  position: {
                    line: match.line,
                    column: match.column!,
                    endColumn: match.column!,
                    requestId: crypto.randomUUID(),
                  },
                }
              : {}),
          };
          return [
            {
              text: match.text,
              range: {
                start: { x: start.x, y: start.y },
                end: { x: end.x + end.width - 1, y: end.y },
              },
              activate: (event: MouseEvent) => {
                if (event.button && event.button !== 0) return;
                if (terminal.buffer.active !== buffer) return;
                let printed = "";
                for (let r = start.y - 1; r < end.y; r++) {
                  const currentLine = buffer.getLine(r);
                  const from = r === start.y - 1 ? start.x - 1 : left;
                  const to = r === end.y - 1 ? end.x + end.width - 1 : right;
                  for (let x = from; x < to; x++) {
                    const cell = currentLine?.getCell(x);
                    if (cell?.getWidth()) printed += cell.getChars() || " ";
                  }
                }
                if (printed !== match.text) return;
                const current = context();
                if (
                  current?.machineId === origin.machineId &&
                  current.sessionName === origin.sessionName &&
                  current.panes.some(
                    (p) =>
                      p.id === pane.id &&
                      p.path === pane.path &&
                      p.windowId === pane.windowId &&
                      p.zoomed === pane.zoomed &&
                      p.position.x === pane.position.x &&
                      p.position.y === pane.position.y &&
                      p.dimensions.cols === pane.dimensions.cols &&
                      p.dimensions.rows === pane.dimensions.rows,
                  )
                )
                  open({
                    ...target,
                    ...(target.position
                      ? { position: { ...target.position, requestId: crypto.randomUUID() } }
                      : {}),
                  });
              },
            },
          ];
        });
      });
      callback(links);
    },
  };
}
