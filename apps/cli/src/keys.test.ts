import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createKeyReader, splitKeys, KEY } from "./keys.js";

/**
 * The half of the panel that can brick a terminal.
 *
 * Everything here is about the two failure modes raw mode creates: a Ctrl+C
 * that does nothing, and a tty left without echo after the process is gone.
 * Both are worse than the feature is good, so both are asserted rather than
 * assumed.
 */

function fakeStdin() {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  const raw: boolean[] = [];
  Object.assign(stream, {
    isTTY: true,
    setRawMode: (on: boolean) => {
      raw.push(on);
      return stream;
    },
  });
  return { stream, raw };
}

describe("the key reader", () => {
  it("runs the interrupt before any binding, and does not pass it on", () => {
    const { stream } = fakeStdin();
    const onInterrupt = vi.fn();
    const handler = vi.fn();
    const reader = createKeyReader({ input: stream, onInterrupt });
    reader.setHandler(handler);

    stream.write("");

    expect(onInterrupt).toHaveBeenCalledOnce();
    // A binding that saw Ctrl+C could swallow it. It never gets the chance.
    expect(handler).not.toHaveBeenCalled();
    reader.stop();
  });

  it("treats Ctrl+D as an interrupt too", () => {
    const { stream } = fakeStdin();
    const onInterrupt = vi.fn();
    const reader = createKeyReader({ input: stream, onInterrupt });
    stream.write("");
    expect(onInterrupt).toHaveBeenCalledOnce();
    reader.stop();
  });

  it("stops at the interrupt rather than running the rest of the chunk", () => {
    const { stream } = fakeStdin();
    const onInterrupt = vi.fn();
    const handler = vi.fn();
    const reader = createKeyReader({ input: stream, onInterrupt });
    reader.setHandler(handler);

    // Someone leaning on the keyboard while pressing Ctrl+C. Acting on `k`
    // after deciding to quit is doing something they cancelled.
    stream.write("ak");

    expect(handler.mock.calls).toEqual([["a"]]);
    expect(onInterrupt).toHaveBeenCalledOnce();
    reader.stop();
  });

  it("restores the terminal on stop", () => {
    const { stream, raw } = fakeStdin();
    const reader = createKeyReader({ input: stream, onInterrupt: vi.fn() });
    expect(raw).toEqual([true]);
    reader.stop();
    expect(raw).toEqual([true, false]);
  });

  it("restores only once, however many times it is stopped", () => {
    const { stream, raw } = fakeStdin();
    const reader = createKeyReader({ input: stream, onInterrupt: vi.fn() });
    reader.stop();
    reader.stop();
    expect(raw).toEqual([true, false]);
  });

  it("delivers every key in a chunk, not just the first", () => {
    const { stream } = fakeStdin();
    const keys: string[] = [];
    const reader = createKeyReader({
      input: stream,
      onInterrupt: vi.fn(),
    });
    reader.setHandler((k) => keys.push(k));

    // A held key, or a paste. Dropping the tail loses input silently.
    stream.write("jjk");
    expect(keys).toEqual(["j", "j", "k"]);
    reader.stop();
  });

  it("is inert when stdin is not a TTY", () => {
    const stream = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stream, { isTTY: false });
    const reader = createKeyReader({ input: stream, onInterrupt: vi.fn() });
    expect(reader.enabled).toBe(false);
  });

  it("gives up rather than reading input the tty still echoes", () => {
    const stream = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stream, {
      isTTY: true,
      setRawMode: () => {
        throw new Error("nope");
      },
    });
    const reader = createKeyReader({ input: stream, onInterrupt: vi.fn() });
    expect(reader.enabled).toBe(false);
  });
});

describe("splitting a chunk into keys", () => {
  it("keeps an arrow sequence whole", () => {
    // Three bytes, one key. Split naively, Up becomes `[` then `A` — and in a
    // panel where letters are bindings that is a wrong action, not a no-op.
    expect(splitKeys("\x1b[A")).toEqual([KEY.up]);
    expect(splitKeys("\x1b[A\x1b[B")).toEqual([KEY.up, KEY.down]);
  });

  it("keeps SS3 and parameterised sequences whole", () => {
    expect(splitKeys("\x1bOP")).toEqual(["\x1bOP"]);
    expect(splitKeys("\x1b[1;5C")).toEqual(["\x1b[1;5C"]);
  });

  it("passes a bare Escape through", () => {
    expect(splitKeys("\x1b")).toEqual([KEY.escape]);
  });

  it("keeps a surrogate pair as one key", () => {
    // Two code units, one character. As two keys it matches nothing, twice.
    expect(splitKeys("😀")).toEqual(["😀"]);
  });

  it("splits ordinary text one character at a time", () => {
    expect(splitKeys("abc")).toEqual(["a", "b", "c"]);
  });
});
