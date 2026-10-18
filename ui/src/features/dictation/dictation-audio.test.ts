import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCapture } from "./dictation-audio";
import { acquireMicrophone, releaseMicrophone } from "./dictation-microphone";
import { disconnectAll } from "@/features/connection/relay-registry";
import { useConnectionStore } from "@/features/connection/connection-store";

class Track extends EventTarget {
  enabled = true;
  readyState = "live";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
}
function device() {
  const track = new Track();
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}
const getUserMedia = vi.fn<() => Promise<MediaStream>>();
const addModule = vi.fn(async () => {});
const contexts: Context[] = [];
const nodes: Worklet[] = [];
class Context {
  destination = {};
  audioWorklet = { addModule };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  source = { connect: vi.fn(), disconnect: vi.fn() };
  createMediaStreamSource = vi.fn(() => this.source);
  constructor() {
    contexts.push(this);
  }
}
class Worklet {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: vi.fn(() => this.port.onmessage?.({ data: { type: "flushed" } })),
  };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    nodes.push(this);
  }
}
let documentEvents: EventTarget & { visibilityState: string };
let windowEvents: EventTarget;
const handlers = () => ({ onFrame: vi.fn(), onLevel: vi.fn(), onEnded: vi.fn() });
const start = (signal = new AbortController().signal) => startCapture(handlers(), signal);

beforeEach(() => {
  documentEvents = Object.assign(new EventTarget(), { visibilityState: "visible" });
  windowEvents = new EventTarget();
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("window", windowEvents);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
  useConnectionStore.setState({ status: "connected" });
  getUserMedia.mockReset();
  addModule.mockReset().mockResolvedValue(undefined);
  contexts.length = 0;
  nodes.length = 0;
});
afterEach(() => {
  releaseMicrophone();
  vi.unstubAllGlobals();
});

describe("microphone lifecycle", () => {
  it("reuses granted stream across recordings, muted with closed audio graph between them", async () => {
    const { track, stream } = device();
    getUserMedia.mockResolvedValue(stream);
    const firstRequest = new AbortController();
    const first = await start(firstRequest.signal);
    expect(track.enabled).toBe(true);
    await first.stop();
    expect(track.enabled).toBe(false);
    expect(track.stop).not.toHaveBeenCalled();
    expect(contexts[0]!.close).toHaveBeenCalled();
    expect(contexts[0]!.source.disconnect).toHaveBeenCalled();
    // Normal dictation completion aborts its controller after stop resolves.
    firstRequest.abort();
    first.abort();
    const second = await start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(track.enabled).toBe(true);
    await second.stop();
    expect(track.enabled).toBe(false);
  });

  it("mutes immediately while final audio flush waits", async () => {
    const { track, stream } = device();
    getUserMedia.mockResolvedValue(stream);
    const capture = await start();
    nodes[0]!.port.postMessage.mockImplementation(() => {});
    const stopping = capture.stop();
    expect(track.enabled).toBe(false);
    nodes[0]!.port.onmessage?.({ data: { type: "flushed" } });
    await stopping;
    expect(nodes[0]!.port.onmessage).toBeNull();
  });

  it("stops tracks and audio graph on cancellation", async () => {
    const { track, stream } = device();
    getUserMedia.mockResolvedValue(stream);
    const request = new AbortController();
    const capture = await start(request.signal);
    request.abort();
    capture.abort();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0]!.close).toHaveBeenCalled();
    expect(nodes[0]!.port.onmessage).toBeNull();
  });

  it.each(["hidden", "pagehide", "disconnect", "lock"])(
    "releases idle microphone on %s",
    async (event) => {
      const { track, stream } = device();
      getUserMedia.mockResolvedValue(stream);
      await (await start()).stop();
      if (event === "hidden") {
        documentEvents.visibilityState = "hidden";
        documentEvents.dispatchEvent(new Event("visibilitychange"));
      } else if (event === "pagehide") windowEvents.dispatchEvent(new Event("pagehide"));
      else if (event === "lock") disconnectAll();
      else useConnectionStore.setState({ status: "reconnecting" });
      expect(track.stop).toHaveBeenCalledTimes(1);
    },
  );

  it("drops late permission grant after cancellation and closes pending context immediately", async () => {
    const { track, stream } = device();
    let grant!: (value: MediaStream) => void;
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const request = new AbortController();
    const pending = start(request.signal);
    request.abort();
    expect(contexts[0]!.close).toHaveBeenCalled();
    grant(stream);
    await expect(pending).rejects.toThrow();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(nodes).toHaveLength(0);
  });

  it("drops late grants after page exit without touching newer capture", async () => {
    const old = device();
    const next = device();
    let grant!: (value: MediaStream) => void;
    getUserMedia
      .mockReturnValueOnce(
        new Promise((resolve) => {
          grant = resolve;
        }),
      )
      .mockResolvedValue(next.stream);
    const pending = acquireMicrophone(new AbortController().signal);
    windowEvents.dispatchEvent(new Event("pagehide"));
    const lease = await acquireMicrophone(new AbortController().signal);
    lease.activate();
    grant(old.stream);
    await expect(pending).rejects.toThrow();
    expect(old.track.stop).toHaveBeenCalledTimes(1);
    expect(next.track.stop).not.toHaveBeenCalled();
    expect(next.track.enabled).toBe(true);
  });

  it("reacquires microphone if retained track ended", async () => {
    const first = device();
    const second = device();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValue(second.stream);
    await (await start()).stop();
    first.track.readyState = "ended";
    const capture = await start();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(second.track.enabled).toBe(true);
    capture.abort();
  });

  it("releases failed audio setup and allows retry", async () => {
    const first = device();
    const second = device();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValue(second.stream);
    addModule.mockRejectedValueOnce(new Error("worklet failed"));
    await expect(start()).rejects.toThrow("Could not start audio processing");
    expect(first.track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0]!.close).toHaveBeenCalled();
    (await start()).abort();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("does not cache denied permission", async () => {
    getUserMedia
      .mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"))
      .mockResolvedValue(device().stream);
    await expect(start()).rejects.toThrow("Microphone blocked");
    (await start()).abort();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("removes ended listeners when recording stops", async () => {
    const { track, stream } = device();
    getUserMedia.mockResolvedValue(stream);
    const firstHandlers = handlers();
    await (await startCapture(firstHandlers, new AbortController().signal)).stop();
    const secondHandlers = handlers();
    const second = await startCapture(secondHandlers, new AbortController().signal);
    track.dispatchEvent(new Event("ended"));
    expect(firstHandlers.onEnded).not.toHaveBeenCalled();
    expect(secondHandlers.onEnded).toHaveBeenCalledOnce();
    second.abort();
  });
});
