import { afterEach, expect, test, vi } from "vitest";
import { createKeyRepeat } from "./key-repeat.js";

afterEach(() => vi.useRealTimers());

test("hold repeats after delay and stops on release", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const repeat = createKeyRepeat(send);
  repeat.start("up");
  expect(send.mock.calls).toEqual([["up"]]);
  vi.advanceTimersByTime(399);
  expect(send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(161);
  expect(send).toHaveBeenCalledTimes(4);
  repeat.stop();
  vi.advanceTimersByTime(1000);
  expect(send).toHaveBeenCalledTimes(4);
});

test("starting another key cancels old repeat", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const repeat = createKeyRepeat(send);
  repeat.start("up");
  vi.advanceTimersByTime(200);
  repeat.start("down");
  vi.advanceTimersByTime(400);
  expect(send.mock.calls).toEqual([["up"], ["down"], ["down"]]);
  repeat.stop();
});
