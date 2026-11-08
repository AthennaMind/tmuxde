import { describe, expect, it } from "vitest";
import type { ILink, Terminal } from "@xterm/xterm";
import {
  fileLinkProvider,
  findFilePaths,
  type FileLinkContext,
  type FileLinkTarget,
} from "./file-links";

function fixture(rows: string[], cols = 40, wrapped: number[] = []) {
  return {
    cols,
    buffer: {
      active: {
        baseY: 0,
        getLine: (index: number) =>
          rows[index] === undefined
            ? undefined
            : {
                isWrapped: wrapped.includes(index),
                getCell: (x: number) => ({
                  getWidth: () => 1,
                  getChars: () => rows[index]![x] ?? " ",
                }),
              },
      },
    },
  } as unknown as Terminal;
}

function context(): FileLinkContext {
  return {
    machineId: "alpha",
    sessionName: "dev",
    panes: [
      {
        id: "%1",
        index: 0,
        active: true,
        zoomed: false,
        windowId: "@1",
        dimensions: { cols: 40, rows: 10 },
        position: { x: 0, y: 0 },
        path: "/workspace",
      },
    ],
  };
}

function links(terminal: Terminal, origin: () => FileLinkContext | null, row = 1) {
  const opened: FileLinkTarget[] = [];
  let found: ILink[] = [];
  fileLinkProvider(terminal, origin, (target) => opened.push(target)).provideLinks(
    row,
    (result) => {
      found = result ?? [];
    },
  );
  return { found, opened };
}

function activate(link: ILink) {
  link.activate({} as MouseEvent, link.text);
}

describe("terminal file links", () => {
  it("recognizes CLI paths, quoted spaces and source positions", () => {
    expect(
      findFilePaths(
        'Read .agents/rules/backend.md intake.py /tmp/log.txt "src/my file.ts:12:3"',
      ).map(({ path, line, column }) => ({ path, line, column })),
    ).toEqual([
      { path: ".agents/rules/backend.md", line: undefined, column: undefined },
      { path: "intake.py", line: undefined, column: undefined },
      { path: "/tmp/log.txt", line: undefined, column: undefined },
      { path: "src/my file.ts", line: 12, column: 3 },
    ]);
  });

  it("ignores URLs, flags, glob patterns and truncated paths", () => {
    expect(
      findFilePaths(
        "https://example.com/x.ts --file=src/a.ts signal.*.py .agents/rule… src/file... plain",
      ),
    ).toEqual([]);
  });

  it("opens relative paths with machine, session and source position", () => {
    const { found, opened } = links(fixture(["Read src/main.ts:12:3"]), context);
    activate(found[0]!);
    expect(opened[0]).toMatchObject({
      machineId: "alpha",
      sessionName: "dev",
      paneId: "%1",
      path: "/workspace/src/main.ts",
      position: { line: 12, column: 3 },
    });
    expect(found[0]!.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 21, y: 1 } });
  });

  it("uses clicked split pane even when another pane is active", () => {
    const origin = context();
    origin.panes[0]!.dimensions.cols = 20;
    origin.panes.push({
      ...origin.panes[0]!,
      id: "%2",
      active: false,
      path: "/other",
      position: { x: 21, y: 0 },
    });
    const { found, opened } = links(fixture(["left.ts".padEnd(20) + "│right.ts"]), () => origin);
    activate(found[1]!);
    expect(opened[0]).toMatchObject({ paneId: "%2", path: "/other/right.ts" });
  });

  it("joins soft wraps and keeps buffer cell coordinates", () => {
    const { found, opened } = links(fixture(["src/long-n", "ame.ts"], 10, [1]), context, 2);
    activate(found[0]!);
    expect(opened[0]!.path).toBe("/workspace/src/long-name.ts");
    expect(found[0]!.range).toEqual({ start: { x: 1, y: 1 }, end: { x: 6, y: 2 } });
  });

  it("rejects stale links after machine changes", () => {
    const origin = context();
    const { found, opened } = links(fixture(["/tmp/file.ts"]), () => ({ ...origin }));
    origin.machineId = "beta";
    activate(found[0]!);
    expect(opened).toEqual([]);
  });
});

describe("terminal path edge cases", () => {
  it("keeps quoted spaces, brackets and punctuation in filenames", () => {
    expect(
      findFilePaths(
        '"src/my file [old].ts":12:3 src/(group)/page.ts [src/test.ts:4] "notes...txt"',
      ).map(({ path, line, column }) => ({ path, line, column })),
    ).toEqual([
      { path: "src/my file [old].ts", line: 12, column: 3 },
      { path: "src/(group)/page.ts", line: undefined, column: undefined },
      { path: "src/test.ts", line: 4, column: 1 },
      { path: "notes...txt", line: undefined, column: undefined },
    ]);
  });

  it("recognizes extensionless names, dotfiles and line anchors", () => {
    expect(
      findFilePaths('Makefile Dockerfile .gitignore "my notes" src/main.ts#L42C5').map(
        ({ path }) => path,
      ),
    ).toEqual(["Makefile", "Dockerfile", ".gitignore", "my notes", "src/main.ts"]);
    expect(findFilePaths("src/main.ts#L42C5")[0]).toMatchObject({ line: 42, column: 5 });
    expect(
      findFilePaths("3.14 127.0.0.1 $HOME/src/file.ts src/file.ts:999999999999999999"),
    ).toEqual([]);
  });

  it("rejects stale text after a TUI redraw", () => {
    const rows = ["src/old.ts"];
    const { found, opened } = links(fixture(rows), context);
    rows[0] = "src/new.ts";
    activate(found[0]!);
    expect(opened).toEqual([]);
  });

  it("rejects links after pane layout or buffer changes", () => {
    const original = context();
    let current = original;
    const terminal = fixture(["src/file.ts"]);
    const { found, opened } = links(terminal, () => current);
    current = {
      ...original,
      panes: original.panes.map((p) => ({ ...p, position: { x: 10, y: 0 } })),
    };
    activate(found[0]!);
    expect(opened).toEqual([]);
    current = original;
    Object.defineProperty(terminal.buffer, "active", {
      value: fixture(["src/file.ts"]).buffer.active,
    });
    activate(found[0]!);
    expect(opened).toEqual([]);
  });

  it("uses a fresh navigation request for repeated clicks", () => {
    const { found, opened } = links(fixture(["src/file.ts:5"]), context);
    activate(found[0]!);
    activate(found[0]!);
    expect(opened).toHaveLength(2);
    expect(opened[0]!.position!.requestId).not.toBe(opened[1]!.position!.requestId);
  });

  it("does not activate right clicks", () => {
    const { found, opened } = links(fixture(["src/file.ts"]), context);
    found[0]!.activate({ button: 2 } as MouseEvent, found[0]!.text);
    expect(opened).toEqual([]);
  });

  it("bounds wrapped-line scanning", () => {
    const rows = Array.from({ length: 100 }, () => "a".repeat(10));
    rows[0] = "/tmp/file-";
    const { found } = links(fixture(rows, 10, rows.map((_, i) => i).slice(1)), context, 50);
    expect(found).toEqual([]);
  });

  it("maps wide and combining characters to terminal cells", () => {
    const cells = [
      { chars: "界", width: 2 },
      { chars: "", width: 0 },
      { chars: " ", width: 1 },
      { chars: "/", width: 1 },
      { chars: "e\u0301", width: 1 },
      { chars: "/", width: 1 },
      { chars: "文", width: 2 },
      { chars: "", width: 0 },
    ];
    const terminal = fixture([""], 8);
    Object.defineProperty(terminal.buffer.active, "getLine", {
      value: (row: number) =>
        row === 0
          ? {
              isWrapped: false,
              getCell: (x: number) => ({
                getWidth: () => cells[x]!.width,
                getChars: () => cells[x]!.chars,
              }),
            }
          : undefined,
    });
    const { found, opened } = links(terminal, context);
    expect(found[0]!.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 8, y: 1 } });
    activate(found[0]!);
    expect(opened[0]!.path).toBe("/e\u0301/文");
  });
});

it("recognizes paths in prose without swallowing closing punctuation", () => {
  expect(
    findFilePaths("(src/main.ts:2). [src/[id]/page.ts]! 2026.txt").map(({ path }) => path),
  ).toEqual(["src/main.ts", "src/[id]/page.ts", "2026.txt"]);
});
