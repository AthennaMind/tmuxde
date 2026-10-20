import { describe, expect, it } from "vitest";
import { COMMAND_INFO, isCommandId, type CommandId, type CommandInfo } from "./command-ids";
import { DEFAULT_KEYBINDINGS } from "./default-keybindings";
import { resolveKeymap, type KeybindingEntry } from "./keymap";
import type { Platform } from "./platform";
import type { FocusState } from "./scope";
import { decideBinding, type BindingEvent } from "./use-keybindings";

interface FakeCommand {
  id: CommandId;
  toggle?: boolean;
  enabled?: () => boolean;
}

function lookupWith(disabled: string[] = []) {
  return (id: string): FakeCommand | undefined => {
    if (!isCommandId(id)) return undefined;
    const info: CommandInfo = COMMAND_INFO[id];
    return {
      id,
      ...(info.toggle ? { toggle: true } : {}),
      ...(disabled.includes(id) ? { enabled: () => false } : {}),
    };
  };
}

function press(over: Partial<BindingEvent>): BindingEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    ...over,
  };
}

const TERMINAL: FocusState = { terminal: true, textEntry: false };
const PAGE: FocusState = { terminal: false, textEntry: false };
const INPUT: FocusState = { terminal: false, textEntry: true };

const ctrl = (letter: string, over: Partial<BindingEvent> = {}) =>
  press({ key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true, ...over });

function decide(
  event: BindingEvent,
  focus: FocusState,
  {
    user = [],
    platform = "other",
    disabled = [],
  }: {
    user?: KeybindingEntry[];
    platform?: Platform;
    disabled?: string[];
  } = {},
) {
  const keymap = resolveKeymap(DEFAULT_KEYBINDINGS, user, platform);
  return decideBinding(event, keymap, focus, lookupWith(disabled));
}

const commandOf = (...args: Parameters<typeof decide>) => decide(...args)?.command.id ?? null;

describe("decideBinding", () => {
  it("keeps app bindings away from the terminal", () => {
    expect(commandOf(ctrl("b"), TERMINAL)).toBeNull();
    expect(commandOf(ctrl("b"), PAGE)).toBe("sidebar.toggle");
    expect(commandOf(ctrl("o"), PAGE)).toBe("overview.toggle");
    expect(commandOf(ctrl("e"), PAGE)).toBe("sidebar.files");
  });

  it("fires global bindings in the terminal", () => {
    expect(commandOf(ctrl("k"), TERMINAL)).toBe("palette.commands");
    expect(commandOf(ctrl("p"), TERMINAL)).toBe("palette.files");
    expect(commandOf(ctrl("f", { key: "F", shiftKey: true }), TERMINAL)).toBe("palette.terminals");
    expect(
      commandOf(press({ key: " ", code: "Space", ctrlKey: true, shiftKey: true }), TERMINAL),
    ).toBe("dictation.toggle");
  });

  it("maps Ctrl with = and Ctrl with + to zoom in", () => {
    expect(commandOf(press({ key: "=", code: "Equal", ctrlKey: true }), TERMINAL)).toBe(
      "terminal.zoomIn",
    );
    expect(
      commandOf(press({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }), TERMINAL),
    ).toBe("terminal.zoomIn");
    expect(commandOf(press({ key: "-", code: "Minus", ctrlKey: true }), PAGE)).toBe(
      "terminal.zoomOut",
    );
    // Readline undo stays with the shell.
    expect(
      commandOf(press({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }), TERMINAL),
    ).toBeNull();
  });

  it("opens shortcuts with a question mark outside text entry only", () => {
    const question = press({ key: "?", code: "Slash", shiftKey: true });
    expect(commandOf(question, PAGE)).toBe("shortcuts.open");
    expect(commandOf(question, INPUT)).toBeNull();
    expect(commandOf(question, TERMINAL)).toBeNull();
  });

  it("lets modified chords fire while text entry has focus", () => {
    expect(commandOf(ctrl("k"), INPUT)).toBe("palette.commands");
    expect(commandOf(ctrl("b"), INPUT)).toBe("sidebar.toggle");
  });

  it("never fires a plain user chord in text entry", () => {
    const user: KeybindingEntry[] = [{ key: "j", command: "palette.files" }];
    expect(commandOf(press({ key: "j", code: "KeyJ" }), INPUT, { user })).toBeNull();
    expect(commandOf(press({ key: "j", code: "KeyJ" }), PAGE, { user })).toBe("palette.files");
  });

  it("swallows key repeat of toggle commands without running them", () => {
    expect(decide(ctrl("k", { repeat: true }), TERMINAL)).toMatchObject({
      command: { id: "palette.commands" },
      repeat: true,
    });
    expect(decide(ctrl("k"), TERMINAL)?.repeat).toBe(false);
    // Zoom is no toggle. Holding the key keeps zooming.
    expect(
      decide(press({ key: "=", code: "Equal", ctrlKey: true, repeat: true }), TERMINAL)?.repeat,
    ).toBe(false);
  });

  it("lets the key through when the command is disabled", () => {
    const dictation = press({ key: " ", code: "Space", ctrlKey: true, shiftKey: true });
    expect(commandOf(dictation, TERMINAL, { disabled: ["dictation.toggle"] })).toBeNull();
  });

  it("falls through to an earlier binding when the later one does not apply", () => {
    const user: KeybindingEntry[] = [{ key: "ctrl+k", command: "sidebar.toggle", scope: "app" }];
    expect(commandOf(ctrl("k"), PAGE, { user })).toBe("sidebar.toggle");
    expect(commandOf(ctrl("k"), TERMINAL, { user })).toBe("palette.commands");
    expect(commandOf(ctrl("k"), PAGE, { user, disabled: ["sidebar.toggle"] })).toBe(
      "palette.commands",
    );
  });

  it("fires terminal scope only in the terminal", () => {
    const user: KeybindingEntry[] = [
      { key: "ctrl+j", command: "terminal.search", scope: "terminal" },
    ];
    expect(commandOf(ctrl("j"), TERMINAL, { user })).toBe("terminal.search");
    expect(commandOf(ctrl("j"), PAGE, { user })).toBeNull();
  });

  it("passes args of the binding", () => {
    const user: KeybindingEntry[] = [
      { key: "ctrl+j", command: "palette.open", args: { mode: "terminals" } },
    ];
    expect(decide(ctrl("j"), PAGE, { user })?.binding.args).toEqual({ mode: "terminals" });
  });

  it("ignores unknown chords, bare modifiers and composition", () => {
    expect(decide(ctrl("j"), PAGE)).toBeNull();
    expect(decide(press({ key: "Control", code: "ControlLeft", ctrlKey: true }), PAGE)).toBeNull();
    expect(decide(press({ key: "k", code: "KeyK" }), PAGE)).toBeNull();
    expect(decide(ctrl("k", { isComposing: true }), PAGE)).toBeNull();
  });

  it("uses Cmd on Mac and gives Ctrl+K back to the shell", () => {
    const cmd = (letter: string) =>
      press({ key: letter, code: `Key${letter.toUpperCase()}`, metaKey: true });
    expect(commandOf(cmd("k"), TERMINAL, { platform: "mac" })).toBe("palette.commands");
    expect(commandOf(ctrl("k"), TERMINAL, { platform: "mac" })).toBeNull();
    expect(commandOf(cmd("b"), TERMINAL, { platform: "mac" })).toBe("sidebar.toggle");
    expect(commandOf(cmd("e"), TERMINAL, { platform: "mac" })).toBe("sidebar.files");
    expect(commandOf(cmd("k"), TERMINAL)).toBeNull();
  });
});
