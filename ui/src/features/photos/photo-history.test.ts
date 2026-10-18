import { describe, expect, it, vi } from "vitest";
import { createPhotoHistory, reusePhotoPath } from "./photo-history";

describe("recent photos", () => {
  it("keeps newest eight paths and moves duplicates to front", () => {
    const history = createPhotoHistory();
    const client = {};
    for (let i = 0; i < 10; i++) history.add(client, `/photo-${i}.png`);
    expect(history.get(client)).toHaveLength(8);
    expect(history.get(client)[0]).toBe("/photo-9.png");
    history.add(client, "/photo-5.png");
    expect(history.get(client)[0]).toBe("/photo-5.png");
    expect(history.get(client)).toHaveLength(8);
    expect(history.get(client)).not.toContain("/photo-0.png");
  });

  it("isolates equal host paths on different connections", () => {
    const history = createPhotoHistory();
    const first = {};
    const second = {};
    history.add(first, "/photo.png");
    expect(history.get(first)).toEqual(["/photo.png"]);
    const firstScope = history.scope(first);
    expect(history.get(second)).toEqual([]);
    history.add(second, "/photo.png");
    expect(history.get(second)).toEqual(["/photo.png"]);
    expect(history.get(second)).not.toBe(history.get(first));
    expect(history.scope(second)).not.toBe(firstScope);
    history.add(first, "/next.png");
    expect(history.scope(first)).toBe(firstScope);
    expect(history.get(null)).toEqual([]);
  });

  it("notifies subscribers only until unsubscribe", () => {
    const history = createPhotoHistory();
    const listener = vi.fn();
    const stop = history.subscribe(listener);
    history.add({}, "/photo.png");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    history.add({}, "/next.png");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

function reuseContext() {
  return {
    load: vi.fn(async () => "blob:photo"),
    release: vi.fn(),
    isCurrent: vi.fn(() => true),
    paste: vi.fn(),
    resetInput: vi.fn(),
  };
}

describe("reuse photo path", () => {
  it("validates saved file then pastes quoted host path without Enter", async () => {
    const context = reuseContext();
    await reusePhotoPath("/uploads/my photo.png", context);
    expect(context.load).toHaveBeenCalledWith("/uploads/my photo.png");
    expect(context.paste).toHaveBeenCalledTimes(1);
    expect(context.paste).toHaveBeenCalledWith(" '/uploads/my photo.png' ");
    expect(context.resetInput).toHaveBeenCalledTimes(1);
    expect(context.release).toHaveBeenCalledWith("blob:photo");
  });

  it("never pastes missing file and explains how to recover", async () => {
    const context = reuseContext();
    context.load.mockRejectedValue(new Error("Failed to load file (404)"));
    await expect(reusePhotoPath("/photo.png", context)).rejects.toThrow(
      "Choose Photo to upload it again",
    );
    expect(context.paste).not.toHaveBeenCalled();
    expect(context.resetInput).not.toHaveBeenCalled();
  });

  it("rejects terminal changes while fetching and releases preview", async () => {
    const context = reuseContext();
    context.load.mockImplementation(async () => {
      context.isCurrent.mockReturnValue(false);
      return "blob:photo";
    });
    await expect(reusePhotoPath("/photo.png", context)).rejects.toThrow("Terminal changed");
    expect(context.paste).not.toHaveBeenCalled();
    expect(context.release).toHaveBeenCalledWith("blob:photo");
  });

  it("rejects stale connection before fetching and unsafe path before paste", async () => {
    const context = reuseContext();
    context.isCurrent.mockReturnValue(false);
    await expect(reusePhotoPath("/photo.png", context)).rejects.toThrow("Terminal changed");
    expect(context.load).not.toHaveBeenCalled();
    context.isCurrent.mockReturnValue(true);
    await expect(reusePhotoPath("/photo\n.png", context)).rejects.toThrow("Invalid photo path");
    expect(context.paste).not.toHaveBeenCalled();
  });
});
