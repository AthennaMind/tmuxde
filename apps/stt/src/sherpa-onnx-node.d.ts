// The package ships JSDoc types only. This covers the offline recognizer.
declare module "sherpa-onnx-node" {
  export interface OfflineRecognizerConfig {
    featConfig?: { sampleRate?: number; featureDim?: number };
    modelConfig: {
      transducer?: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads?: number;
      provider?: string;
      debug?: number;
    };
    decodingMethod?: string;
  }

  export interface OfflineRecognizerResult {
    text: string;
    lang?: string;
  }

  export class OfflineStream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
  }

  export class OfflineRecognizer {
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
  }

  export interface VadConfig {
    sileroVad: {
      model: string;
      threshold?: number;
      minSilenceDuration?: number;
      minSpeechDuration?: number;
      windowSize?: number;
      maxSpeechDuration?: number;
    };
    sampleRate?: number;
    numThreads?: number;
    provider?: string;
    debug?: number;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
    pop(): void;
    flush(): void;
  }

  const sherpa: {
    OfflineRecognizer: typeof OfflineRecognizer;
    Vad: typeof Vad;
    version: string;
  };
  export default sherpa;
}
