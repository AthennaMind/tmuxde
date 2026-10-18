import { describe, expect, it } from "vitest";
import type { PaneInfo } from "@/protocol";
import { paneLayout, processPresentation, windowPresentation } from "./session-presentation";

function pane(id: number, command = "bash", path = "/workspace"): PaneInfo {
  return {
    id: `%${id}`,
    index: id,
    windowId: "@0",
    active: id === 0,
    zoomed: false,
    command,
    path,
    position: { x: id * 41, y: 0 },
    dimensions: { cols: 40, rows: 24 },
  };
}

describe("session presentation", () => {
  it("shows what runs when tmux named the window after a shell or a command", () => {
    expect(windowPresentation("bash", [pane(0), pane(1, "claude")])).toEqual({
      label: "Claude Code",
      processes: "Claude Code",
      folder: "/workspace",
      custom: false,
    });
    expect(windowPresentation("top", [pane(0, "top"), pane(1)]).label).toBe("top");
    expect(windowPresentation("3", [pane(0, "codex")]).label).toBe("Codex");
  });

  it("keeps a name someone set and deduplicates processes", () => {
    expect(windowPresentation("review", [pane(0, "codex"), pane(1, "codex")])).toEqual({
      label: "review",
      processes: "Codex",
      folder: "/workspace",
      custom: true,
    });
  });

  it("calls a window of shells Terminal and counts distinct folders", () => {
    expect(windowPresentation("sh", [pane(0), pane(1, "sh", "/tmp")])).toEqual({
      label: "Terminal",
      processes: undefined,
      folder: "2 folders",
      custom: false,
    });
  });

  it("keeps the name before the panes are listed", () => {
    expect(windowPresentation("logs", []).label).toBe("logs");
    expect(windowPresentation("zsh", []).label).toBe("Terminal");
    expect(windowPresentation("zsh", []).folder).toBeUndefined();
  });

  it("handles login shells, executable paths and missing commands", () => {
    expect(processPresentation("/bin/-zsh").label).toBe("Terminal");
    expect(processPresentation().label).toBe("Terminal");
    expect(processPresentation("/usr/bin/python3.14").label).toBe("Python");
    expect(processPresentation("node").label).toBe("Node.js");
    expect(processPresentation("my-worker").label).toBe("my-worker");
  });
});

describe("pane layout map", () => {
  it("preserves nested horizontal and vertical splits from tmux layout", () => {
    const rects = paneLayout("abcd,81x24,0,0{40x24,0,0,0,40x24,41,0[40x11,41,0,1,40x12,41,12,2]}", [
      pane(0),
      pane(1),
      pane(2),
    ]);
    expect(rects).toEqual([
      { id: "%0", x: 0, y: 0, width: 40 / 81, height: 1 },
      { id: "%1", x: 41 / 81, y: 0, width: 40 / 81, height: 11 / 24 },
      { id: "%2", x: 41 / 81, y: 12 / 24, width: 40 / 81, height: 12 / 24 },
    ]);
  });

  it("uses saved layout while zoomed pane dimensions fill window", () => {
    const zoomed = { ...pane(0), zoomed: true, dimensions: { cols: 81, rows: 24 } };
    const rects = paneLayout("abcd,81x24,0,0{40x24,0,0,0,40x24,41,0,1}", [zoomed, pane(1)]);
    expect(rects[0]?.width).toBe(40 / 81);
    expect(rects[1]?.x).toBe(41 / 81);
  });

  it("falls back to pane geometry when layout is absent or stale", () => {
    for (const layout of ["", "abcd,40x24,0,0,9"]) {
      const rects = paneLayout(layout, [pane(0), pane(1)]);
      expect(rects).toHaveLength(2);
      expect(rects[1]).toEqual({ id: "%1", x: 41 / 81, y: 0, width: 40 / 81, height: 1 });
    }
    expect(paneLayout("", [])).toEqual([]);
  });
});
