/**
 * Microphone capture for dictation: 16 kHz mono PCM16 in 200 ms frames.
 *
 * Resampling happens in an AudioWorklet (`public/dictation-worklet.js`) at
 * whatever rate the device runs. Asking the AudioContext for 16 kHz instead
 * is not reliable across browsers with a microphone source.
 */

export type Capture = {
  /** Flush the last partial frame, then release the microphone. */
  stop: () => Promise<void>;
  /** Release the microphone at once and drop anything unsent. */
  abort: () => void;
};

export type CaptureHandlers = {
  onFrame: (pcm: Int16Array) => void;
  onLevel: (level: number) => void;
  /** The microphone went away: unplugged, or taken by the system. */
  onEnded: () => void;
};

/** Why the microphone could not be opened, in words a person can act on. */
export class MicrophoneError extends Error {}

const FLUSH_TIMEOUT_MS = 500;

function describe(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone blocked. Allow it for this site in browser settings.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone found";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Microphone is in use by another app";
  }
  return "Could not open the microphone";
}

/**
 * Open the microphone and start producing frames.
 *
 * Call from a user gesture. iOS only lets an AudioContext run if it was
 * created and resumed inside one, which is why both happen before the first
 * await.
 */
export async function startCapture(handlers: CaptureHandlers): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
    throw new MicrophoneError("This browser cannot record audio here");
  }
  const context = new AudioContext();
  const resumed = context.resume();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    void context.close();
    throw new MicrophoneError(describe(error));
  }

  const release = () => {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
  };

  let node: AudioWorkletNode;
  try {
    await resumed;
    await context.audioWorklet.addModule("/dictation-worklet.js");
    node = new AudioWorkletNode(context, "dictation-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
    });
  } catch {
    release();
    throw new MicrophoneError("Could not start audio processing");
  }

  let flushed: (() => void) | null = null;
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as
      | { type: "pcm"; pcm: ArrayBuffer }
      | { type: "level"; level: number }
      | { type: "flushed" };
    if (data.type === "pcm") handlers.onFrame(new Int16Array(data.pcm));
    else if (data.type === "level") handlers.onLevel(data.level);
    else flushed?.();
  };

  const source = context.createMediaStreamSource(stream);
  source.connect(node);
  // The node writes nothing to its output. Connected anyway, because some
  // engines only run nodes that lead to the destination.
  node.connect(context.destination);

  let done = false;
  const track = stream.getAudioTracks()[0];
  track?.addEventListener("ended", () => {
    if (!done) handlers.onEnded();
  });

  const disconnect = () => {
    done = true;
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    release();
  };

  return {
    async stop() {
      if (done) return;
      await new Promise<void>((resolve) => {
        flushed = resolve;
        node.port.postMessage({ type: "flush" });
        setTimeout(resolve, FLUSH_TIMEOUT_MS);
      });
      disconnect();
    },
    abort() {
      if (!done) disconnect();
    },
  };
}

/** Base64 of the frame's bytes, little endian as every browser stores them. */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
