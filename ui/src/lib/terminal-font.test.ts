import { describe, expect, it, vi } from "vitest";
import { refreshWhenFontLoads, terminalFontFamily } from "./terminal-font.js";

function terminal() {
  return {
    element: { isConnected: true } as HTMLElement,
    rows: 24,
    clearTextureAtlas: vi.fn(),
    refresh: vi.fn(),
  };
}

describe("terminal icon font", () => {
  it("replaces old unbundled default with bundled reading font", () => {
    expect(
      terminalFontFamily(
        "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      ),
    ).toBe(
      '"Symbols Nerd Font Mono", "Cascadia Code", "IBM Plex Mono", monospace',
    );
  });
  it("replaces previous bundled default with Cascadia Code", () => {
    expect(terminalFontFamily('"IBM Plex Mono", monospace')).toBe(
      '"Symbols Nerd Font Mono", "Cascadia Code", "IBM Plex Mono", monospace',
    );
  });
  it("supports saved text fonts without replacing their preference", () => {
    const saved = "'JetBrains Mono', monospace";
    expect(terminalFontFamily(saved)).toBe(
      '"Symbols Nerd Font Mono", ' + saved,
    );
  });

  it("invalidates cached missing glyphs after font download completes", async () => {
    const finish: Array<(faces: FontFace[]) => void> = [];
    const load = vi.fn(
      () =>
        new Promise<FontFace[]>((resolve) => {
          finish.push(resolve);
        }),
    );
    const view = terminal();
    const remeasure = vi.fn();
    const ready = refreshWhenFontLoads(view, { load }, remeasure);
    expect(view.clearTextureAtlas).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith(
      '16px "Symbols Nerd Font Mono"',
      "\ue0b0",
    );
    expect(load).toHaveBeenCalledWith('400 16px "Cascadia Code"', "W");
    finish[0]!([]);
    await Promise.resolve();
    expect(remeasure).not.toHaveBeenCalled();
    finish.forEach((resolve) => resolve([]));
    await ready;
    expect(remeasure).toHaveBeenCalledOnce();
    expect(view.clearTextureAtlas).toHaveBeenCalledOnce();
    expect(view.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("does not repaint terminal disposed during font download", async () => {
    const view = terminal();
    const load = vi.fn(async () => {
      view.element = { isConnected: false } as HTMLElement;
      return [];
    });
    await refreshWhenFontLoads(view, { load });
    expect(view.clearTextureAtlas).not.toHaveBeenCalled();
    expect(view.refresh).not.toHaveBeenCalled();
  });

  it("remeasures text when icon font fails but text fonts load", async () => {
    const view = terminal();
    const remeasure = vi.fn();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([]);
    await refreshWhenFontLoads(view, { load }, remeasure);
    expect(remeasure).toHaveBeenCalledOnce();
    expect(view.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("keeps terminal usable when font download fails", async () => {
    const view = terminal();
    await expect(
      refreshWhenFontLoads(view, {
        load: vi.fn().mockRejectedValue(new Error("offline")),
      }),
    ).resolves.toBeUndefined();
    expect(view.refresh).not.toHaveBeenCalled();
  });
});
