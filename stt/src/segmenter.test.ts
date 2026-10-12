import { describe, expect, it } from "vitest";
import { AudioHistory, chunkSegmenter } from "./segmenter.ts";

const ramp = (from: number, length: number) =>
  Float32Array.from({ length }, (_, i) => from + i);

describe("AudioHistory", () => {
  it("reads back by absolute index across writes", () => {
    const history = new AudioHistory();
    history.write(ramp(0, 10));
    history.write(ramp(10, 10));
    expect(Array.from(history.read(8, 12))).toEqual([8, 9, 10, 11]);
  });

  it("only returns what it still holds", () => {
    const history = new AudioHistory();
    history.write(ramp(0, 30 * 16000 + 100));
    expect(history.read(0, 102)).toHaveLength(2);
    expect(history.read(30 * 16000 + 90, 30 * 16000 + 200)).toHaveLength(10);
  });
});

describe("chunkSegmenter", () => {
  it("returns the remainder as one piece on flush", () => {
    const segmenter = chunkSegmenter();
    expect(segmenter.push(new Float32Array(16000))).toEqual([]);
    expect(segmenter.flush().map((p) => p.length)).toEqual([16000]);
    expect(segmenter.flush()).toEqual([]);
  });
});
