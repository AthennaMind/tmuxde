import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * A key the toolbar can send, and where it belongs in the sheet.
 *
 * `key` is the literal byte sequence written to the pty — not a browser
 * `KeyboardEvent.key`. Nothing translates it, so what is written here is what
 * the program on the other end reads.
 */
interface ToolbarKey {
  id: string;
  label: string;
  key: string;
  visible: boolean;
  group: ToolbarKeyGroup;
  /** What it does, for the sheet and the settings list. */
  hint?: string;
}

type ToolbarKeyGroup = "core" | "agent" | "nav" | "edit" | "symbol";

const GROUP_LABELS: Record<ToolbarKeyGroup, string> = {
  core: "Basics",
  agent: "Agent CLIs",
  nav: "Moving around",
  edit: "Editing the line",
  symbol: "Symbols",
};

/**
 * The keys a phone cannot otherwise send.
 *
 * A soft keyboard has no modifiers to hold, so this row is the *only* way to
 * send anything with Ctrl, Alt or Shift in it. The list was built for a shell —
 * arrows, pipe, tilde — and an agent CLI needs a different set:
 *
 * - `Shift+Tab` (`\x1b[Z`, CSI Z) cycles Claude Code's permission modes and
 *   moves backwards through Codex's fields. There was no way to send it at all,
 *   which is what makes it the reason this list changed.
 * - `Alt+Enter` (`\x1b\r`) inserts a newline instead of submitting, so a
 *   multi-line prompt can be typed without the message going early.
 * - `Esc Esc` rewinds to edit the previous message.
 * - `@` and `#` open file and memory pickers, and both are two taps deep on an
 *   iOS keyboard.
 *
 * Only the first two are visible by default. A toolbar of thirty keys is a
 * toolbar nobody can find anything in — the rest live one tap away in the key
 * sheet, which is also where they get pinned into this row.
 */
const defaultToolbarKeys: ToolbarKey[] = [
  // Core — what was here before, unchanged in behaviour and order.
  { id: "tab", label: "Tab", key: "\t", visible: true, group: "core" },
  { id: "esc", label: "Esc", key: "\x1b", visible: true, group: "core" },
  {
    id: "ctrl",
    label: "Ctrl",
    key: "",
    visible: true,
    group: "core",
    hint: "Sticky — press, then a letter",
  },
  {
    id: "alt",
    label: "Alt",
    key: "",
    visible: true,
    group: "core",
    hint: "Sticky — press, then a key",
  },
  { id: "up", label: "↑", key: "\x1b[A", visible: true, group: "core" },
  { id: "down", label: "↓", key: "\x1b[B", visible: true, group: "core" },
  { id: "left", label: "←", key: "\x1b[D", visible: true, group: "core" },
  { id: "right", label: "→", key: "\x1b[C", visible: true, group: "core" },

  // Agent CLIs — the reason this list grew.
  {
    id: "shift-tab",
    label: "⇧Tab",
    key: "\x1b[Z",
    visible: true,
    group: "agent",
    hint: "Cycle permission modes in Claude Code; back a field in Codex",
  },
  {
    id: "alt-enter",
    label: "⌥⏎",
    key: "\x1b\r",
    visible: true,
    group: "agent",
    hint: "Newline without sending the message",
  },
  {
    id: "esc-esc",
    label: "Esc Esc",
    key: "\x1b\x1b",
    visible: false,
    group: "agent",
    hint: "Rewind to edit your previous message",
  },
  {
    id: "ctrl-r",
    label: "^R",
    key: "\x12",
    visible: false,
    group: "agent",
    hint: "Expand the transcript; reverse-search in a shell",
  },
  {
    id: "ctrl-o",
    label: "^O",
    key: "\x0f",
    visible: false,
    group: "agent",
    hint: "Toggle verbose output",
  },
  {
    id: "shift-enter",
    label: "⇧⏎",
    key: "\x1b\r",
    visible: false,
    group: "agent",
    hint: "Same sequence as ⌥⏎ — what most terminals send for Shift+Enter",
  },

  // Moving around.
  { id: "home", label: "Home", key: "\x1b[H", visible: false, group: "nav" },
  { id: "end", label: "End", key: "\x1b[F", visible: false, group: "nav" },
  { id: "pgup", label: "PgUp", key: "\x1b[5~", visible: false, group: "nav" },
  { id: "pgdn", label: "PgDn", key: "\x1b[6~", visible: false, group: "nav" },
  {
    id: "word-left",
    label: "⌥←",
    key: "\x1b[1;5D",
    visible: false,
    group: "nav",
    hint: "Back one word",
  },
  {
    id: "word-right",
    label: "⌥→",
    key: "\x1b[1;5C",
    visible: false,
    group: "nav",
    hint: "Forward one word",
  },
  {
    id: "delete",
    label: "Del",
    key: "\x1b[3~",
    visible: false,
    group: "nav",
    hint: "Forward delete",
  },

  // Editing the line — readline, which every one of these CLIs inherits.
  {
    id: "ctrl-a",
    label: "^A",
    key: "\x01",
    visible: false,
    group: "edit",
    hint: "Jump to the start of the line",
  },
  {
    id: "ctrl-e",
    label: "^E",
    key: "\x05",
    visible: false,
    group: "edit",
    hint: "Jump to the end of the line",
  },
  {
    id: "ctrl-u",
    label: "^U",
    key: "\x15",
    visible: false,
    group: "edit",
    hint: "Clear the line before the cursor",
  },
  {
    id: "ctrl-k",
    label: "^K",
    key: "\x0b",
    visible: false,
    group: "edit",
    hint: "Clear the line after the cursor",
  },
  {
    id: "ctrl-w",
    label: "^W",
    key: "\x17",
    visible: false,
    group: "edit",
    hint: "Delete the word before the cursor",
  },
  {
    id: "ctrl-l",
    label: "^L",
    key: "\x0c",
    visible: false,
    group: "edit",
    hint: "Clear the screen",
  },

  // Symbols — the ones that are two taps deep on a phone keyboard.
  { id: "pipe", label: "|", key: "|", visible: true, group: "symbol" },
  { id: "dash", label: "-", key: "-", visible: true, group: "symbol" },
  { id: "tilde", label: "~", key: "~", visible: true, group: "symbol" },
  { id: "slash", label: "/", key: "/", visible: true, group: "symbol" },
  {
    id: "at",
    label: "@",
    key: "@",
    visible: false,
    group: "symbol",
    hint: "Mention a file",
  },
  {
    id: "hash",
    label: "#",
    key: "#",
    visible: false,
    group: "symbol",
    hint: "Add to memory",
  },
  { id: "bang", label: "!", key: "!", visible: false, group: "symbol" },
  { id: "dollar", label: "$", key: "$", visible: false, group: "symbol" },
  { id: "star", label: "*", key: "*", visible: false, group: "symbol" },
  { id: "backtick", label: "`", key: "`", visible: false, group: "symbol" },
  { id: "caret", label: "^", key: "^", visible: false, group: "symbol" },
  { id: "amp", label: "&", key: "&", visible: false, group: "symbol" },
];

/**
 * The gestures the client actually implements.
 *
 * Every key here gates real behaviour in the gesture reducer. That is the only
 * rule this list has, and it was broken twice: `twoFingerScroll` (see below)
 * and, until they were removed, `doubleTapToCopy` and `longPressContextMenu` —
 * both shipped as switches, both defaulted on, both read by nothing. A switch
 * that does nothing is worse than a missing feature, because the user turns it
 * on and concludes the gesture is broken on their phone.
 */
interface GestureSettings {
  swipeToSwitchSessions: boolean;
  swipeToSwitchPanes: boolean;
  /**
   * A one-finger vertical drag scrolls tmux's history.
   *
   * Named for what it is. Its predecessor was `twoFingerScroll`, which was
   * shipped as a toggle, persisted, shown in settings — and wired to no code
   * at all, because with tmux on the alternate screen there was nothing on the
   * client to scroll. Scrolling is now a `tmux:scroll` round trip and a
   * one-finger drag is what performs it, so the old name described neither the
   * gesture nor the mechanism.
   */
  dragToScroll: boolean;
  pinchToZoom: boolean;
}

interface SettingsStore {
  toolbarKeys: ToolbarKey[];
  gestures: GestureSettings;
  hapticEnabled: boolean;
  autoZoom: boolean;
  setToolbarKeys: (keys: ToolbarKey[]) => void;
  toggleToolbarKey: (id: string) => void;
  resetToolbarKeys: () => void;
  setGesture: <K extends keyof GestureSettings>(
    key: K,
    value: GestureSettings[K],
  ) => void;
  setHapticEnabled: (enabled: boolean) => void;
  setAutoZoom: (enabled: boolean) => void;
}

/**
 * Merge new default keys into a user's stored row.
 *
 * Without this the whole change above is invisible to everyone who has ever
 * opened the app: `persist` writes the array to localStorage on first run and
 * hands that frozen copy back forever, so a key added to `defaultToolbarKeys`
 * reaches new installs only.
 *
 * The user's own `visible` choices win — they turned those on and off on
 * purpose — but the sequence, label, group and hint always come from the
 * default, so a typo in a control code can be fixed by a release rather than by
 * asking people to clear their site data. Keys no longer in the defaults are
 * dropped; there is no way to author a custom one, so a leftover id is a
 * removed key rather than something of the user's.
 */
export function mergeToolbarKeys(
  stored: readonly Partial<ToolbarKey>[] | undefined,
): ToolbarKey[] {
  const seen = new Map(
    (stored ?? [])
      .filter((k): k is Partial<ToolbarKey> & { id: string } => !!k?.id)
      .map((k) => [k.id, k]),
  );
  return defaultToolbarKeys.map((fallback) => {
    const previous = seen.get(fallback.id);
    return previous && typeof previous.visible === "boolean"
      ? { ...fallback, visible: previous.visible }
      : fallback;
  });
}

/**
 * Keep the gestures that still exist, and only those.
 *
 * `{ ...current, ...stored }` was the old line, and it copies a *removed* key
 * straight back out of localStorage on every load — for as long as that
 * browser profile lives. Nothing renders it, so nothing goes visibly wrong;
 * the persisted blob just quietly becomes a second, longer list of what the
 * app supports than the app's own. Iterating the current keys instead means
 * deleting a gesture from the interface above is the whole deletion.
 */
export function mergeGestures(
  stored: Partial<GestureSettings> | undefined,
  current: GestureSettings,
): GestureSettings {
  const merged = { ...current };
  for (const key of Object.keys(current) as (keyof GestureSettings)[]) {
    const value = stored?.[key];
    if (typeof value === "boolean") merged[key] = value;
  }
  return merged;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      toolbarKeys: defaultToolbarKeys,
      gestures: {
        swipeToSwitchSessions: true,
        swipeToSwitchPanes: true,
        dragToScroll: true,
        pinchToZoom: true,
      },
      hapticEnabled: true,
      autoZoom: true,
      setToolbarKeys: (toolbarKeys) => set({ toolbarKeys }),
      toggleToolbarKey: (id) =>
        set((s) => ({
          toolbarKeys: s.toolbarKeys.map((k) =>
            k.id === id ? { ...k, visible: !k.visible } : k,
          ),
        })),
      resetToolbarKeys: () => set({ toolbarKeys: defaultToolbarKeys }),
      setGesture: (key, value) =>
        set((s) => ({ gestures: { ...s.gestures, [key]: value } })),
      setHapticEnabled: (hapticEnabled) => set({ hapticEnabled }),
      setAutoZoom: (autoZoom) => set({ autoZoom }),
    }),
    {
      name: "ccremote-settings",
      version: 2,
      // Runs for a stored version below 2 — and `merge` below covers the case
      // `migrate` cannot see, where the persisted blob is already version 2 but
      // predates a key added afterwards.
      migrate: (persisted) => {
        const state = persisted as Partial<SettingsStore> | undefined;
        return {
          ...state,
          toolbarKeys: mergeToolbarKeys(state?.toolbarKeys),
        } as SettingsStore;
      },
      merge: (persisted, current) => {
        const state = persisted as Partial<SettingsStore> | undefined;
        return {
          ...current,
          ...state,
          gestures: mergeGestures(state?.gestures, current.gestures),
          toolbarKeys: mergeToolbarKeys(state?.toolbarKeys),
        };
      },
    },
  ),
);

export { defaultToolbarKeys, GROUP_LABELS };
export type { ToolbarKey, ToolbarKeyGroup, GestureSettings };
