import { describe, expect, it } from "vitest";
import { EMPTY_FILE_SELECTION, selectFile } from "./file-selection";

const visible = ["/folder", "/folder/a", "/folder/b", "/c", "/d"];

describe("file selection", () => {
  it("selects visible ranges across expanded folders", () => {
    const first = selectFile(EMPTY_FILE_SELECTION, "/folder/a", visible, {});
    const range = selectFile(first, "/d", visible, { range: true });
    expect([...range.paths]).toEqual(["/folder/a", "/folder/b", "/c", "/d"]);
    expect(range.anchor).toBe("/folder/a");
  });

  it("shrinks and reverses ranges around original anchor", () => {
    const first = selectFile(EMPTY_FILE_SELECTION, "/folder/b", visible, {});
    const range = selectFile(first, "/d", visible, { range: true });
    const shrunk = selectFile(range, "/c", visible, { range: true });
    expect([...shrunk.paths]).toEqual(["/folder/b", "/c"]);
    const reversed = selectFile(shrunk, "/folder", visible, { range: true });
    expect([...reversed.paths]).toEqual(["/folder", "/folder/a", "/folder/b"]);
    expect(reversed.anchor).toBe("/folder/b");
  });

  it("toggles disjoint entries and anchors next range at clicked entry", () => {
    const first = selectFile(EMPTY_FILE_SELECTION, "/folder/a", visible, {});
    const added = selectFile(first, "/d", visible, { additive: true });
    expect([...added.paths]).toEqual(["/folder/a", "/d"]);
    const removed = selectFile(added, "/folder/a", visible, { additive: true });
    expect([...removed.paths]).toEqual(["/d"]);
    expect(removed.anchor).toBe("/folder/a");
  });

  it("adds ranges to existing disjoint selection", () => {
    const first = selectFile(EMPTY_FILE_SELECTION, "/folder", visible, {});
    const added = selectFile(first, "/c", visible, { additive: true });
    const range = selectFile(added, "/d", visible, { additive: true, range: true });
    expect([...range.paths]).toEqual(["/folder", "/c", "/d"]);
  });

  it("replaces selection on plain click", () => {
    const previous = { paths: new Set(visible), anchor: "/folder" };
    expect([...selectFile(previous, "/c", visible, {}).paths]).toEqual(["/c"]);
    expect([...previous.paths]).toEqual(visible);
  });

  it("never includes hidden descendants in ranges", () => {
    const collapsed = ["/folder", "/c", "/d"];
    const first = selectFile(EMPTY_FILE_SELECTION, "/folder", collapsed, {});
    expect([...selectFile(first, "/d", collapsed, { range: true }).paths]).toEqual(collapsed);
  });

  it("drops removed rows and falls back when anchor disappeared", () => {
    const previous = { paths: new Set(["/gone", "/d"]), anchor: "/gone" };
    const next = selectFile(previous, "/c", visible, { range: true, additive: true });
    expect([...next.paths]).toEqual(["/d", "/c"]);
    expect(next.anchor).toBe("/c");
  });
});
