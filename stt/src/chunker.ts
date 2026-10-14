// Adapted from Orca `src/main/speech/stt-offline-audio-chunker.ts`.
// MIT License, Copyright (c) 2026 Lovecast Inc.

/**
 * Longest buffer decoded in one call.
 *
 * Parakeet is an offline model and decodes a whole buffer at once. Memory
 * grows with buffer length, so long dictation is decoded in bounded chunks.
 * Each chunk also turns into text while the user is still talking.
 */
export const CHUNK_SECONDS = 30;

// A cut in the middle of a word hurts recognition on both sides of it. The
// quietest 100 ms in the last 5 s of a chunk is almost always a pause between
// words. Shorter windows match the silence inside a plosive and cut mid word.
const SPLIT_SEARCH_SECONDS = 5;
const SPLIT_WINDOW_SECONDS = 0.1;

export class AudioChunker {
  private buffered: Float32Array[] = [];
  private bufferedSamples = 0;
  private readonly limit: number;
  private readonly search: number;
  private readonly window: number;

  constructor(sampleRate: number, chunkSeconds = CHUNK_SECONDS) {
    this.limit = Math.max(1, Math.round(chunkSeconds * sampleRate));
    this.search = Math.round(SPLIT_SEARCH_SECONDS * sampleRate);
    this.window = Math.max(1, Math.round(SPLIT_WINDOW_SECONDS * sampleRate));
  }

  /** Buffer samples. Returns chunks that are full and ready to decode. */
  push(samples: Float32Array): Float32Array[] {
    if (samples.length === 0) return [];
    this.buffered.push(samples);
    this.bufferedSamples += samples.length;

    const ready: Float32Array[] = [];
    while (this.bufferedSamples >= this.limit) {
      const combined = this.combine();
      const split = this.quietSplit(combined);
      ready.push(combined.slice(0, split));
      const tail = combined.slice(split);
      this.buffered = tail.length > 0 ? [tail] : [];
      this.bufferedSamples = tail.length;
    }
    return ready;
  }

  /** Everything still buffered, always shorter than one chunk. */
  flush(): Float32Array | null {
    if (this.bufferedSamples === 0) return null;
    const combined = this.combine();
    this.buffered = [];
    this.bufferedSamples = 0;
    return combined;
  }

  private combine(): Float32Array {
    if (this.buffered.length === 1) return this.buffered[0]!;
    const combined = new Float32Array(this.bufferedSamples);
    let offset = 0;
    for (const part of this.buffered) {
      combined.set(part, offset);
      offset += part.length;
    }
    return combined;
  }

  private quietSplit(samples: Float32Array): number {
    const limit = Math.min(this.limit, samples.length);
    const start = Math.max(0, limit - this.search);
    const hop = Math.max(1, Math.floor(this.window / 2));
    let best = limit;
    let bestEnergy = Infinity;
    for (let from = start; from + this.window <= limit; from += hop) {
      let energy = 0;
      for (let i = from; i < from + this.window; i += 1) {
        const sample = samples[i]!;
        energy += sample * sample;
      }
      if (energy < bestEnergy) {
        bestEnergy = energy;
        best = from + Math.floor(this.window / 2);
      }
    }
    // A split must consume at least one sample, or push() never ends.
    return Math.max(1, best);
  }
}
