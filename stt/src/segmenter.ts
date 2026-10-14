import { existsSync } from "node:fs";
import { AudioChunker, CHUNK_SECONDS } from "./chunker.ts";
import { SAMPLE_RATE } from "./pcm.ts";

/**
 * Cuts a stream of audio into pieces that are each decoded on their own.
 *
 * `push` returns pieces that are complete. `flush` returns the rest at the
 * end of a dictation.
 */
export interface Segmenter {
  push(samples: Float32Array): Float32Array[];
  flush(): Float32Array[];
}

/** Fixed chunks of up to 30 s, cut at the quietest moment near the end. */
export function chunkSegmenter(): Segmenter {
  const chunker = new AudioChunker(SAMPLE_RATE);
  return {
    push: (samples) => chunker.push(samples),
    flush: () => {
      const rest = chunker.flush();
      return rest ? [rest] : [];
    },
  };
}

// Silero runs on 32 ms windows at 16 kHz.
const WINDOW = 512;
/**
 * Audio kept from before each utterance. Silero marks speech a little after
 * it starts, and a soft first sound ("С", "f", "h") falls off the front:
 * "Сплавите" came back as "Плавете".
 */
const PREROLL = Math.round(0.3 * SAMPLE_RATE);
// An utterance is only handed over once it ends, up to 25 s after it began,
// so the ring has to reach back further than that.
const HISTORY = 30 * SAMPLE_RATE;

/** The last few seconds of audio, addressed by absolute sample index. */
export class AudioHistory {
  private ring = new Float32Array(HISTORY);
  /** Samples written so far, the absolute index of the next one. */
  written = 0;

  write(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.ring[(this.written + i) % HISTORY] = samples[i]!;
    }
    this.written += samples.length;
  }

  /** Samples [from, to), clipped to what is still held. */
  read(from: number, to: number): Float32Array {
    const start = Math.max(from, this.written - HISTORY, 0);
    const end = Math.min(to, this.written);
    const out = new Float32Array(Math.max(0, end - start));
    for (let i = 0; i < out.length; i++) out[i] = this.ring[(start + i) % HISTORY]!;
    return out;
  }
}

/**
 * One piece per utterance, cut where the speaker pauses.
 *
 * This is why there is a VAD at all. Parakeet picks one language per decode,
 * so a buffer holding an English sentence and a Bulgarian one comes back in
 * one language with the other sentence gone. Decoded one utterance at a
 * time, each sentence keeps its own language. Text also arrives after every
 * pause rather than every 30 s, and silence is never decoded, so the model
 * cannot invent words for it.
 */
export async function loadVadSegmenter(modelPath: string): Promise<() => Segmenter> {
  if (!existsSync(modelPath)) {
    throw new Error(`VAD model missing at ${modelPath}. Run scripts/setup.sh --dictation.`);
  }
  const { default: sherpa } = await import("sherpa-onnx-node");
  const config = {
    sileroVad: {
      model: modelPath,
      threshold: 0.5,
      // Shorter pauses happen inside sentences. Longer ones end a thought.
      minSilenceDuration: 0.6,
      minSpeechDuration: 0.25,
      windowSize: WINDOW,
      maxSpeechDuration: 25,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: "cpu",
    debug: 0,
  };
  // Fail at startup, not on someone's first word.
  new sherpa.Vad(config, 60);

  return () => {
    const vad = new sherpa.Vad(config, 60);
    const history = new AudioHistory();
    let pending = new Float32Array(0);
    /** Where the last utterance ended, so pre-roll never repeats it. */
    let lastEnd = 0;

    const accept = (window: Float32Array) => {
      history.write(window);
      vad.acceptWaveform(window);
    };

    const drain = () => {
      const out: Float32Array[] = [];
      while (!vad.isEmpty()) {
        // A copy: the segment's memory belongs to the detector until pop.
        const { start, samples } = vad.front(false);
        vad.pop();
        const before = history.read(Math.max(start - PREROLL, lastEnd), start);
        const segment = new Float32Array(before.length + samples.length);
        segment.set(before);
        segment.set(samples, before.length);
        lastEnd = start + samples.length;
        out.push(...bounded(segment));
      }
      return out;
    };

    return {
      push(samples) {
        const all = new Float32Array(pending.length + samples.length);
        all.set(pending);
        all.set(samples, pending.length);
        let offset = 0;
        for (; offset + WINDOW <= all.length; offset += WINDOW) {
          accept(all.slice(offset, offset + WINDOW));
        }
        pending = all.slice(offset);
        return drain();
      },
      flush() {
        if (pending.length) {
          const last = new Float32Array(WINDOW);
          last.set(pending);
          accept(last);
          pending = new Float32Array(0);
        }
        vad.flush();
        return drain();
      },
    };
  };
}

/** The VAD caps utterances at 25 s. Never hand the model more than 30. */
function bounded(segment: Float32Array): Float32Array[] {
  if (segment.length <= CHUNK_SECONDS * SAMPLE_RATE) return [segment];
  const chunker = new AudioChunker(SAMPLE_RATE);
  const pieces = chunker.push(segment);
  const rest = chunker.flush();
  return rest ? [...pieces, rest] : pieces;
}
