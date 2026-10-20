/**
 * Command ids, titles and groups, without the code that runs them.
 *
 * Ids are stable. They live in user keybindings files, so a rename breaks
 * someone's bindings. Kept apart from `commands.ts` so the keymap, the store
 * and their tests do not load every feature store.
 *
 * Only app commands are bound. Keys for tmux and the shell stay with the
 * user's tmux config, so tmux actions run from the palette only.
 */

export const COMMAND_GROUPS = [
  { id: "palette", title: "Palette" },
  { id: "workspace", title: "Workspace" },
  { id: "terminal", title: "Terminal" },
  { id: "dictation", title: "Dictation" },
  { id: "security", title: "Security" },
  { id: "appearance", title: "Appearance" },
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number]["id"];

export interface CommandInfo {
  title: string;
  group: CommandGroup;
  /**
   * Skip key repeat. Holding the key runs the command once. Set for commands
   * that flip state or create something, where a repeat would undo or flood.
   */
  toggle?: boolean;
}

export const COMMAND_INFO = {
  "palette.commands": { title: "Command palette", group: "palette", toggle: true },
  "palette.files": { title: "Find files", group: "palette", toggle: true },
  "palette.terminals": { title: "Search terminals", group: "palette", toggle: true },
  "palette.open": { title: "Open palette in a mode", group: "palette", toggle: true },

  "sidebar.toggle": { title: "Toggle sidebar", group: "workspace", toggle: true },
  "sidebar.files": { title: "Toggle files", group: "workspace", toggle: true },
  "overview.toggle": { title: "Toggle overview", group: "workspace", toggle: true },
  "settings.open": { title: "Open settings", group: "workspace", toggle: true },
  "shortcuts.open": { title: "Show keyboard shortcuts", group: "workspace", toggle: true },
  "views.previous": { title: "Previous view", group: "workspace", toggle: true },
  "views.next": { title: "Next view", group: "workspace", toggle: true },
  "views.close": { title: "Close current view", group: "workspace" },
  "views.closeAll": { title: "Close all views", group: "workspace", toggle: true },

  "terminal.zoomIn": { title: "Larger text, terminal or open file", group: "terminal" },
  "terminal.zoomOut": { title: "Smaller text, terminal or open file", group: "terminal" },
  "terminal.zoomReset": { title: "Reset text size", group: "terminal" },
  "terminal.search": { title: "Find in terminal", group: "terminal", toggle: true },

  "dictation.toggle": { title: "Start or stop dictation", group: "dictation", toggle: true },

  "lock.now": { title: "Lock now", group: "security", toggle: true },
  "session.disconnect": { title: "Disconnect this browser", group: "security", toggle: true },

  "theme.light": { title: "Light theme", group: "appearance" },
  "theme.dark": { title: "Dark theme", group: "appearance" },
  "theme.system": { title: "System theme", group: "appearance" },
} as const satisfies Record<string, CommandInfo>;

export type CommandId = keyof typeof COMMAND_INFO;

export const COMMAND_IDS = Object.keys(COMMAND_INFO) as CommandId[];

export function isCommandId(id: string): id is CommandId {
  return Object.hasOwn(COMMAND_INFO, id);
}
