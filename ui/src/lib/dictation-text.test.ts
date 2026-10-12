import { describe, expect, it } from "vitest";
import {
  insertIntoField,
  isTextField,
  joinSegment,
  sanitizeDictation,
} from "./dictation-text";
import { isDictationKey } from "./dictation-key";
import {
  Downsampler,
  FRAME_SAMPLES,
} from "../../public/dictation-worklet.js";

describe("sanitizeDictation", () => {
  it("keeps words in any script", () => {
    expect(sanitizeDictation("Пусни тестовете в relay-а")).toBe(
      "Пусни тестовете в relay-а",
    );
  });

  it("removes anything a terminal would act on", () => {
    expect(sanitizeDictation("rm\x1b[2J -rf\x03 \x9b31m")).toBe("rm[2J -rf 31m");
  });

  it("turns line breaks into spaces so nothing runs", () => {
    expect(sanitizeDictation("first line\nsecond\r\nthird")).toBe(
      "first line second third",
    );
  });

  it("collapses to nothing for silence", () => {
    expect(sanitizeDictation("  \n ")).toBe("");
  });
});

describe("joinSegment", () => {
  it("puts a space between pieces of speech", () => {
    expect(joinSegment("fix the bug", "in the relay")).toBe(" in the relay");
    expect(joinSegment("Направи commit.", "После push")).toBe(" После push");
  });

  it("adds no space at the start or before punctuation", () => {
    expect(joinSegment("", "hello")).toBe("hello");
    expect(joinSegment("hello", ", world")).toBe(", world");
    expect(joinSegment("call (", "this")).toBe("this");
  });

  it("never doubles a space", () => {
    expect(joinSegment("hello ", "world")).toBe("world");
  });
});

describe("isTextField", () => {
  const el = (over: Record<string, unknown>) =>
    ({
      tagName: "TEXTAREA",
      type: "textarea",
      readOnly: false,
      disabled: false,
      classList: { contains: () => false },
      ...over,
    }) as unknown as Element;

  it("accepts editable textareas and text inputs", () => {
    expect(isTextField(el({}))).toBe(true);
    expect(isTextField(el({ tagName: "INPUT", type: "text" }))).toBe(true);
  });

  it("rejects xterm's own textarea, read-only fields and buttons", () => {
    expect(isTextField(el({ classList: { contains: () => true } }))).toBe(false);
    expect(isTextField(el({ readOnly: true }))).toBe(false);
    expect(isTextField(el({ tagName: "INPUT", type: "checkbox" }))).toBe(false);
    expect(isTextField(el({ tagName: "BUTTON" }))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe("insertIntoField", () => {
  it("replaces the selection and fires input so React sees it", () => {
    const events: string[] = [];
    const field = {
      value: "git commit -m ",
      selectionStart: 14,
      selectionEnd: 14,
      setRangeText(text: string, start: number, end: number) {
        this.value = this.value.slice(0, start) + text + this.value.slice(end);
      },
      dispatchEvent(event: Event) {
        events.push(event.type);
        return true;
      },
    };
    insertIntoField(field as unknown as HTMLTextAreaElement, "fix login");
    expect(field.value).toBe("git commit -m fix login");
    expect(events).toEqual(["input"]);
  });
});

describe("isDictationKey", () => {
  const key = (over: Partial<KeyboardEvent>) => ({
    key: " ",
    code: "Space",
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    ...over,
  });

  it("is Ctrl+Shift+Space only", () => {
    expect(isDictationKey(key({}))).toBe(true);
    expect(isDictationKey(key({ shiftKey: false }))).toBe(false);
    expect(isDictationKey(key({ altKey: true }))).toBe(false);
    expect(isDictationKey(key({ metaKey: true }))).toBe(false);
    expect(isDictationKey(key({ key: "a", code: "KeyA" }))).toBe(false);
  });
});

describe("Downsampler", () => {
  function run(rate: number, input: Float32Array) {
    const frames: Int16Array[] = [];
    const levels: number[] = [];
    const downsampler = new Downsampler(rate);
    downsampler.push(input, (f: Int16Array) => frames.push(f), (l: number) => levels.push(l));
    return { frames, levels, rest: downsampler.flush() };
  }

  it("makes one 16 kHz sample per three at 48 kHz", () => {
    const { frames, rest } = run(48000, new Float32Array(48000).fill(0.5));
    const total = frames.length * FRAME_SAMPLES + (rest?.length ?? 0);
    expect(total).toBe(16000);
    // Typed array stores truncate: 0.5 * 32767 is 16383.5.
    expect(frames[0]![0]).toBe(16383);
  });

  it("handles rates that do not divide evenly", () => {
    const { frames, rest } = run(44100, new Float32Array(44100));
    const total = frames.length * FRAME_SAMPLES + (rest?.length ?? 0);
    expect(Math.abs(total - 16000)).toBeLessThanOrEqual(1);
  });

  it("averages away a tone above the speech band", () => {
    // 16 kHz at 48 kHz: plain picking every third sample would keep it.
    const tone = new Float32Array(48000);
    for (let i = 0; i < tone.length; i++) {
      tone[i] = Math.sin((2 * Math.PI * 16000 * i) / 48000);
    }
    const { frames } = run(48000, tone);
    const peak = Math.max(...Array.from(frames[0]!, Math.abs));
    expect(peak).toBeLessThan(100);
  });

  it("clamps and reports level", () => {
    const { frames, levels } = run(16000, new Float32Array(FRAME_SAMPLES).fill(2));
    expect(frames[0]![0]).toBe(32767);
    expect(levels[0]).toBeCloseTo(1);
  });

  it("returns the partial frame on flush, once", () => {
    const downsampler = new Downsampler(16000);
    downsampler.push(new Float32Array(100), () => {}, () => {});
    expect(downsampler.flush()).toHaveLength(100);
    expect(downsampler.flush()).toBeNull();
  });
});
