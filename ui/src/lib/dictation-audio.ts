import { acquireMicrophone } from "@/lib/dictation-microphone";

/**
 * Microphone capture for dictation: 16 kHz mono PCM16 in 200 ms frames.
 *
 * Resampling happens in an AudioWorklet (`public/dictation-worklet.js`) at
 * whatever rate the device runs. Asking the AudioContext for 16 kHz instead
 * is not reliable across browsers with a microphone source.
 */

export type Capture = {
  /** Mute microphone, flush final frame, and close audio processing. */
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
export async function startCapture(handlers: CaptureHandlers, signal: AbortSignal): Promise<Capture> {
  signal.throwIfAborted();
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
    throw new MicrophoneError("This browser cannot record audio here");
  }
  const context = new AudioContext();
  const closeContext = () => {
    signal.removeEventListener("abort", closeContext);
    void context.close().catch(() => undefined);
  };
  signal.addEventListener("abort", closeContext, { once: true });
  // Observe rejection immediately, even while permission prompt is pending.
  const resumed = context.resume().then(() => true, () => false);

  let microphone: Awaited<ReturnType<typeof acquireMicrophone>>;
  try {
    microphone = await acquireMicrophone(signal);
  } catch (error) {
    closeContext();
    throw new MicrophoneError(describe(error));
  }

  const release = (retain: boolean) => {
    if (retain) microphone.pause();
    else microphone.discard();
    closeContext();
  };

  let node: AudioWorkletNode;
  try {
    if (!await resumed) throw new Error("Audio context did not resume");
    signal.throwIfAborted();
    await context.audioWorklet.addModule("/dictation-worklet.js");
    node = new AudioWorkletNode(context, "dictation-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
    });
  } catch {
    release(false);
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

  let source: MediaStreamAudioSourceNode;
  try {
    source = context.createMediaStreamSource(microphone.stream);
    source.connect(node);
    // Silent output keeps worklet running on browsers that require a destination.
    node.connect(context.destination);
    microphone.activate();
  } catch {
    node.port.onmessage = null;
    node.disconnect();
    release(false);
    throw new MicrophoneError("Could not start audio processing");
  }

  let done = false;
  const track = microphone.stream.getAudioTracks()[0];
  const ended = () => {
    if (!done) handlers.onEnded();
  };
  track?.addEventListener("ended", ended);

  const disconnect = (retain: boolean) => {
    if (done) return;
    done = true;
    signal.removeEventListener("abort", abort);
    track?.removeEventListener("ended", ended);
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    release(retain);
  };
  const abort = () => disconnect(false);
  signal.addEventListener("abort", abort, { once: true });

  return {
    async stop() {
      if (done) return;
      microphone.pause();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        flushed = () => { clearTimeout(timer); resolve(); };
        node.port.postMessage({ type: "flush" });
      });
      disconnect(true);
    },
    abort() {
      abort();
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
