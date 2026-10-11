import { existsSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_RATE } from "./pcm.ts";

export interface Transcriber {
  /** Text for one buffer of 16 kHz mono samples. Empty for silence. */
  transcribe(samples: Float32Array): Promise<string>;
}

export const MODEL_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
] as const;

/**
 * Run one decode at a time.
 *
 * Each decode already uses every thread it was given. Two at once would only
 * split those threads and make both slower, and a second person talking would
 * push the first one's wait up for no gain.
 */
export function serialize(
  decode: (samples: Float32Array) => Promise<string>,
): Transcriber {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    transcribe(samples) {
      const run = tail.then(() => decode(samples));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/** Load Parakeet TDT through sherpa-onnx. Loading takes a few seconds. */
export async function loadParakeet(
  modelDir: string,
  threads: number,
): Promise<Transcriber> {
  const missing = MODEL_FILES.filter((file) => !existsSync(join(modelDir, file)));
  if (missing.length) {
    throw new Error(
      `Model files missing in ${modelDir}: ${missing.join(", ")}. Run scripts/setup.sh --dictation.`,
    );
  }
  // Imported here so tests of everything else never load the native addon.
  const { default: sherpa } = await import("sherpa-onnx-node");
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(modelDir, "encoder.int8.onnx"),
        decoder: join(modelDir, "decoder.int8.onnx"),
        joiner: join(modelDir, "joiner.int8.onnx"),
      },
      tokens: join(modelDir, "tokens.txt"),
      numThreads: threads,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
  });
  return serialize(async (samples) => {
    // Offline streams are single use. A fresh one per buffer.
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    const result = await recognizer.decodeAsync(stream);
    return result.text.trim();
  });
}
