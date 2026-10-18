// Types for public/dictation-worklet.js, which the dictation tests import.
// The worklet stays plain JavaScript. The browser loads it as is through
// audioWorklet.addModule, and TypeScript does not read JavaScript here.
declare module "*/public/dictation-worklet.js" {
  export const TARGET_RATE: number;
  export const FRAME_SAMPLES: number;

  /** Turns device-rate float samples into 16 kHz PCM16 frames. */
  export class Downsampler {
    constructor(inputRate: number);
    push(
      input: Float32Array,
      onFrame: (frame: Int16Array) => void,
      onLevel: (level: number) => void,
    ): void;
    /** The partial frame, or null when there is none. */
    flush(): Int16Array | null;
  }
}
