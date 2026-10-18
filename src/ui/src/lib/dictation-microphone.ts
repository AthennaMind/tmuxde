import { onDisconnectAll } from "@/lib/relay-registry";
import { useConnectionStore } from "@/stores/connection-store";

let stream: MediaStream | null = null;
let generation = 0;
let cleanup: (() => void) | null = null;

/** Release retained access on lock, sign-out, disconnect, or page exit. */
export function releaseMicrophone(): void {
  generation += 1;
  cleanup?.();
  cleanup = null;
  const previous = stream;
  stream = null;
  for (const track of previous?.getTracks() ?? []) track.stop();
}

/** Reuse granted access. Disabled tracks produce silence between recordings. */
export async function acquireMicrophone(signal: AbortSignal) {
  signal.throwIfAborted();
  if (!stream?.getAudioTracks().some((track) => track.readyState === "live")) {
    releaseMicrophone();
  }
  const current = ++generation;
  const discard = () => {
    if (generation === current) releaseMicrophone();
  };
  signal.addEventListener("abort", discard, { once: true });
  if (!cleanup) {
    const hidden = () => {
      if (document.visibilityState === "hidden") releaseMicrophone();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", releaseMicrophone);
    const offLock = onDisconnectAll(releaseMicrophone);
    const offConnection = useConnectionStore.subscribe((next, previous) => {
      if (next.status !== previous.status && next.status !== "connected") releaseMicrophone();
    });
    cleanup = () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", releaseMicrophone);
      offLock();
      offConnection();
    };
  }

  try {
    const acquired = stream ?? await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // Permission can arrive after Cancel, lock, or another recording starts.
    if (signal.aborted || current !== generation) {
      for (const track of acquired.getTracks()) track.stop();
      throw new DOMException("Microphone request cancelled", "AbortError");
    }
    stream = acquired;
    for (const track of acquired.getAudioTracks()) track.enabled = false;
    return {
      stream: acquired,
      activate() {
        signal.throwIfAborted();
        if (current !== generation || !acquired.getAudioTracks().some((track) => track.readyState === "live")) {
          throw new DOMException("Microphone no longer available", "AbortError");
        }
        for (const track of acquired.getAudioTracks()) track.enabled = true;
      },
      pause() {
        signal.removeEventListener("abort", discard);
        if (current === generation) {
          for (const track of acquired.getAudioTracks()) track.enabled = false;
        }
      },
      discard() {
        signal.removeEventListener("abort", discard);
        discard();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", discard);
    discard();
    throw error;
  }
}
