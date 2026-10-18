// Microphone to 16 kHz mono PCM16 for dictation. Loaded with
// `audioWorklet.addModule`, so it runs on the audio thread. Not type checked:
// the audio worklet globals are not part of the DOM library.

export const TARGET_RATE = 16000;
/** 200 ms per frame: five messages a second toward the relay. */
export const FRAME_SAMPLES = 3200;
/** Level updates for the meter, about twenty a second. */
const LEVEL_SAMPLES = 800;

/**
 * Turns device-rate float samples into 16 kHz PCM16 frames.
 *
 * Each output sample is the average of the input samples it covers. That is
 * a crude low-pass, but it keeps most of the hiss above 8 kHz from folding
 * back into the speech band, which plain sample picking does not.
 */
export class Downsampler {
  /** @param {number} inputRate */
  constructor(inputRate) {
    this.step = inputRate / TARGET_RATE;
    this.until = this.step;
    this.position = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
    this.levelSum = 0;
    this.levelCount = 0;
  }

  /**
   * @param {Float32Array} input
   * @param {(frame: Int16Array) => void} onFrame
   * @param {(level: number) => void} onLevel RMS of recent output, 0 to 1
   */
  push(input, onFrame, onLevel) {
    for (let i = 0; i < input.length; i++) {
      this.sum += /** @type {number} */ (input[i]);
      this.count += 1;
      this.position += 1;
      if (this.position < this.until) continue;
      this.until += this.step;
      const value = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.frame[this.filled++] = value < 0 ? value * 32768 : value * 32767;
      this.levelSum += value * value;
      this.levelCount += 1;
      if (this.levelCount === LEVEL_SAMPLES) {
        onLevel(Math.sqrt(this.levelSum / this.levelCount));
        this.levelSum = 0;
        this.levelCount = 0;
      }
      if (this.filled === FRAME_SAMPLES) {
        onFrame(this.frame);
        this.frame = new Int16Array(FRAME_SAMPLES);
        this.filled = 0;
      }
    }
  }

  /** The partial frame, or null when there is none. */
  flush() {
    if (this.filled === 0) return null;
    const rest = this.frame.slice(0, this.filled);
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
    return rest;
  }
}

if (typeof AudioWorkletProcessor !== "undefined") {
  class DictationCapture extends AudioWorkletProcessor {
    constructor() {
      super();
      // `sampleRate` is the context's rate, a global in worklet scope.
      this.downsampler = new Downsampler(sampleRate);
      this.port.onmessage = (event) => {
        if (event.data?.type !== "flush") return;
        const rest = this.downsampler.flush();
        if (rest) this.port.postMessage({ type: "pcm", pcm: rest.buffer }, [rest.buffer]);
        this.port.postMessage({ type: "flushed" });
      };
    }

    /** @param {Float32Array[][]} inputs */
    process(inputs) {
      const channel = inputs[0]?.[0];
      if (channel) {
        this.downsampler.push(
          channel,
          (frame) => this.port.postMessage({ type: "pcm", pcm: frame.buffer }, [frame.buffer]),
          (level) => this.port.postMessage({ type: "level", level }),
        );
      }
      return true;
    }
  }
  registerProcessor("dictation-capture", DictationCapture);
}
