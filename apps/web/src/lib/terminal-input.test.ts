import { beforeEach, describe, expect, it } from "vitest";
import { consumeTerminalInput, useTerminalInput } from "./terminal-input.js";

describe("live terminal modifiers", () => {
  beforeEach(() => useTerminalInput.getState().reset());

  it("applies Ctrl to next typed letter only", () => {
    useTerminalInput.getState().toggle("ctrl");
    expect(consumeTerminalInput("c")).toBe("\x03");
    expect(consumeTerminalInput("c")).toBe("c");
    expect(useTerminalInput.getState().ctrl).toBe(false);
  });

  it("combines Alt and Ctrl", () => {
    useTerminalInput.getState().toggle("ctrl");
    useTerminalInput.getState().toggle("alt");
    expect(consumeTerminalInput("a")).toBe("\x1b\x01");
    expect(useTerminalInput.getState().alt).toBe(false);
  });

  it.each([
    [" ", "\x00"],
    ["?", "\x7f"],
    ["[", "\x1b"],
  ])("supports Ctrl with %j", (key, expected) => {
    useTerminalInput.getState().toggle("ctrl");
    expect(consumeTerminalInput(key)).toBe(expected);
  });

  it("preserves actual Enter and arrow sequences", () => {
    expect(consumeTerminalInput("\r")).toBe("\r");
    useTerminalInput.getState().toggle("ctrl");
    expect(consumeTerminalInput("\x1b[A")).toBe("\x1b[A");
    expect(useTerminalInput.getState().ctrl).toBe(false);
  });

  it("does not add modifiers to composed text or pasted blocks", () => {
    useTerminalInput.getState().toggle("alt");
    expect(consumeTerminalInput("hello\nworld")).toBe("hello\nworld");
    useTerminalInput.getState().toggle("ctrl");
    expect(consumeTerminalInput("日本語")).toBe("日本語");
  });

  it("resets a pending modifier when leaving live input", () => {
    useTerminalInput.getState().toggle("ctrl");
    useTerminalInput.getState().reset();
    expect(consumeTerminalInput("d")).toBe("d");
  });

  it.each([
    "\x1b[12;40R",
    "\x1b[?1;2c",
    "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
    "\x1b[I",
  ])("does not apply or consume modifiers for terminal reply %j", (reply) => {
    useTerminalInput.getState().toggle("alt");
    expect(consumeTerminalInput(reply)).toBe(reply);
    expect(consumeTerminalInput("b")).toBe("\x1bb");
  });

  it("clears modifiers on bracketed paste without altering text", () => {
    useTerminalInput.getState().toggle("ctrl");
    const paste = "\x1b[200~some text\x1b[201~";
    expect(consumeTerminalInput(paste)).toBe(paste);
    expect(consumeTerminalInput("c")).toBe("c");
  });
});
