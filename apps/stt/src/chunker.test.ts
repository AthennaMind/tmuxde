import { describe, expect, it } from "vitest";
import { AudioChunker } from "./chunker.ts";
import { pcm16ToFloat32 } from "./pcm.ts";

const RATE = 100;

/** Loud everywhere except one quiet stretch. */
function speech(length: number, quietFrom = -1, quietTo = -1): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = i >= quietFrom && i < quietTo ? 0 : 0.5;
  }
  return samples;
}

describe("AudioChunker", () => {
  it("holds audio until a chunk is full", () => {
    const chunker = new AudioChunker(RATE, 10);
    expect(chunker.push(speech(500))).toEqual([]);
    expect(chunker.flush()).toHaveLength(500);
    expect(chunker.flush()).toBeNull();
  });

  it("cuts a full chunk at the quietest pause near its end", () => {
    const chunker = new AudioChunker(RATE, 10);
    // 10 s chunk at 100 Hz is 1000 samples. Pause at 7.5 s to 7.8 s.
    const ready = chunker.push(speech(1200, 750, 780));
    expect(ready).toHaveLength(1);
    const cut = ready[0]!.length;
    expect(cut).toBeGreaterThanOrEqual(750);
    expect(cut).toBeLessThanOrEqual(780);
    // Nothing lost at the cut.
    expect(cut + chunker.flush()!.length).toBe(1200);
  });

  it("keeps every chunk within the limit for long input", () => {
    const chunker = new AudioChunker(RATE, 10);
    const ready = chunker.push(speech(3500));
    expect(ready.length).toBeGreaterThanOrEqual(3);
    for (const chunk of ready) expect(chunk.length).toBeLessThanOrEqual(1000);
    const total = ready.reduce((sum, c) => sum + c.length, 0) + (chunker.flush()?.length ?? 0);
    expect(total).toBe(3500);
  });
});

describe("pcm16ToFloat32", () => {
  it("reads little-endian signed samples", () => {
    const bytes = Buffer.alloc(6);
    bytes.writeInt16LE(16384, 0);
    bytes.writeInt16LE(-32768, 2);
    bytes.writeInt16LE(0, 4);
    expect(Array.from(pcm16ToFloat32(bytes)!)).toEqual([0.5, -1, 0]);
  });

  it("refuses half a sample", () => {
    expect(pcm16ToFloat32(Buffer.alloc(3))).toBeNull();
  });

  it("respects the byte offset of a slice", () => {
    const bytes = Buffer.alloc(4);
    bytes.writeInt16LE(16384, 2);
    expect(Array.from(pcm16ToFloat32(bytes.subarray(2))!)).toEqual([0.5]);
  });
});
