import { describe, expect, it, vi } from "vitest";

import {
  CastAssembler,
  CastFetchError,
  fetchCast,
  type CastChunk,
  type FetchTransport,
} from "./cast-fetch";

const ID = "rec_aaaaaaaaaaaaaaaa";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function chunk(over: Partial<CastChunk> & { data: string }): CastChunk {
  return {
    id: ID,
    offset: 0,
    totalBytes: over.data.length,
    final: false,
    ...over,
    data: b64(over.data),
  };
}

describe("CastAssembler", () => {
  it("joins chunks in order", () => {
    const a = new CastAssembler();
    a.push(chunk({ data: "hel", offset: 0, totalBytes: 5 }));
    a.push(chunk({ data: "lo", offset: 3, totalBytes: 5, final: true }));
    expect(a.complete).toBe(true);
    expect(a.text()).toBe("hello");
  });

  it("reports progress and the offset a resume should use", () => {
    const a = new CastAssembler();
    a.push(chunk({ data: "hel", offset: 0, totalBytes: 5 }));
    expect(a.progress).toEqual({ receivedBytes: 3, totalBytes: 5 });
    expect(a.nextOffset).toBe(3);
  });

  it("drops a chunk that repeats bytes it already has", () => {
    // What a resume after a dropped socket looks like. Appending it would
    // silently corrupt the file.
    const a = new CastAssembler();
    a.push(chunk({ data: "hello", offset: 0, totalBytes: 6 }));
    a.push(chunk({ data: "hello", offset: 0, totalBytes: 6 }));
    // Overlapping, not merely repeated: bytes 3-5 of a 6-byte file, of which
    // the first two are already here. Only the tail is new.
    a.push(chunk({ data: "lo!", offset: 3, totalBytes: 6, final: true }));
    expect(a.text()).toBe("hello!");
  });

  it("throws on a hole rather than concatenating across it", () => {
    // A `.cast` with a gap in the middle still parses, and plays back wrong.
    const a = new CastAssembler();
    a.push(chunk({ data: "hel", offset: 0, totalBytes: 10 }));
    expect(() =>
      a.push(chunk({ data: "!!", offset: 7, totalBytes: 10, final: true })),
    ).toThrow(/gap at byte 3/);
  });

  it("refuses to hand back an unfinished transfer", () => {
    const a = new CastAssembler();
    a.push(chunk({ data: "hel", offset: 0, totalBytes: 10 }));
    expect(() => a.text()).toThrow(CastFetchError);
  });

  it("handles an empty recording that is final immediately", () => {
    const a = new CastAssembler();
    a.push(chunk({ data: "", offset: 0, totalBytes: 0, final: true }));
    expect(a.text()).toBe("");
  });

  it("round-trips bytes that are not ASCII", () => {
    const a = new CastAssembler();
    const text = '[0,"o","→ ✓ 日本語"]';
    const bytes = Buffer.from(text, "utf8");
    a.push({
      id: ID,
      offset: 0,
      data: bytes.toString("base64"),
      totalBytes: bytes.length,
      final: true,
    });
    expect(a.text()).toBe(text);
  });

  it("reassembles a multi-byte character split across two chunks", () => {
    // 64 KiB slices are taken by byte offset, so a chunk boundary lands in the
    // middle of a UTF-8 sequence sooner or later. Decoding must happen once,
    // over the joined bytes — not per chunk.
    const bytes = Buffer.from("日本語", "utf8");
    const a = new CastAssembler();
    a.push({
      id: ID,
      offset: 0,
      data: bytes.subarray(0, 4).toString("base64"),
      totalBytes: bytes.length,
      final: false,
    });
    a.push({
      id: ID,
      offset: 4,
      data: bytes.subarray(4).toString("base64"),
      totalBytes: bytes.length,
      final: true,
    });
    expect(a.text()).toBe("日本語");
  });
});

describe("fetchCast", () => {
  function transport(): FetchTransport & {
    emit(chunk: CastChunk): void;
    request: ReturnType<typeof vi.fn<FetchTransport["request"]>>;
    listeners: number;
  } {
    const listeners: Array<(c: CastChunk) => void> = [];
    return {
      request: vi.fn<FetchTransport["request"]>(),
      onChunk(listener) {
        listeners.push(listener);
        return () => {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      emit(c) {
        for (const listener of [...listeners]) listener(c);
      },
      get listeners() {
        return listeners.length;
      },
    };
  }

  it("asks for the recording and resolves with its text", async () => {
    const t = transport();
    const promise = fetchCast({ transport: t, id: ID });
    expect(t.request).toHaveBeenCalledWith(ID, 0);
    t.emit(chunk({ data: "hi", offset: 0, totalBytes: 2, final: true }));
    await expect(promise).resolves.toBe("hi");
  });

  it("ignores chunks for a different recording", async () => {
    const t = transport();
    const promise = fetchCast({ transport: t, id: ID });
    t.emit({
      id: "rec_bbbbbbbbbbbbbbbb",
      offset: 0,
      data: b64("other"),
      totalBytes: 5,
      final: true,
    });
    t.emit(chunk({ data: "mine", offset: 0, totalBytes: 4, final: true }));
    await expect(promise).resolves.toBe("mine");
  });

  it("reports progress as chunks land", async () => {
    const t = transport();
    const seen: number[] = [];
    const promise = fetchCast({
      transport: t,
      id: ID,
      onProgress: (p) => seen.push(p.receivedBytes),
    });
    t.emit(chunk({ data: "ab", offset: 0, totalBytes: 4 }));
    t.emit(chunk({ data: "cd", offset: 2, totalBytes: 4, final: true }));
    await promise;
    expect(seen).toEqual([2, 4]);
  });

  it("unsubscribes once it is done", async () => {
    const t = transport();
    const promise = fetchCast({ transport: t, id: ID });
    t.emit(chunk({ data: "x", offset: 0, totalBytes: 1, final: true }));
    await promise;
    expect(t.listeners).toBe(0);
  });

  it("rejects and unsubscribes on a hole", async () => {
    const t = transport();
    const promise = fetchCast({ transport: t, id: ID });
    t.emit(chunk({ data: "ab", offset: 0, totalBytes: 10 }));
    t.emit(chunk({ data: "z", offset: 9, totalBytes: 10, final: true }));
    await expect(promise).rejects.toThrow(/gap/);
    expect(t.listeners).toBe(0);
  });

  it("rejects and unsubscribes when aborted", async () => {
    const t = transport();
    const controller = new AbortController();
    const promise = fetchCast({
      transport: t,
      id: ID,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow(/Cancelled/);
    expect(t.listeners).toBe(0);
  });
});
