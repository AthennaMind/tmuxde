import type { DefaultKeybindingEntry } from "./keymap";

/**
 * Bindings every user starts with. User entries follow these and win.
 *
 * Linux and Windows keep Ctrl+B, Ctrl+E and Ctrl+O outside the terminal,
 * because inside it Ctrl+B is the tmux prefix. Those three skip Mac. There
 * Ctrl+B and Ctrl+E move the cursor in text fields and Monaco. Mac gets Cmd
 * variants that work everywhere instead, since xterm never sends Cmd
 * combinations to tmux. Mac also gives Ctrl+K and Ctrl+P back to the shell.
 *
 * Views switch with Alt+PageUp and Alt+PageDown. The browser keeps Ctrl+Tab
 * and Ctrl+PageUp for its own tabs. Mac laptops have no PageUp key, so Mac
 * uses Cmd+Alt with a bracket.
 */
export const DEFAULT_KEYBINDINGS: readonly DefaultKeybindingEntry[] = [
  { key: "ctrl+k", mac: "cmd+k", command: "palette.commands", scope: "global" },
  { key: "ctrl+p", mac: "cmd+p", command: "palette.files", scope: "global" },
  { key: "ctrl+shift+f", mac: "cmd+shift+f", command: "palette.terminals", scope: "global" },
  { key: "ctrl+b", command: "sidebar.toggle", scope: "app", platform: "other" },
  { mac: "cmd+b", command: "sidebar.toggle", scope: "global" },
  { key: "ctrl+o", command: "overview.toggle", scope: "app", platform: "other" },
  { mac: "cmd+o", command: "overview.toggle", scope: "global" },
  { key: "ctrl+e", command: "sidebar.files", scope: "app", platform: "other" },
  { mac: "cmd+e", command: "sidebar.files", scope: "global" },
  { key: "ctrl+=", mac: "cmd+=", command: "terminal.zoomIn", scope: "global" },
  { key: "ctrl+shift+=", mac: "cmd+shift+=", command: "terminal.zoomIn", scope: "global" },
  { key: "ctrl+-", mac: "cmd+-", command: "terminal.zoomOut", scope: "global" },
  { key: "ctrl+0", mac: "cmd+0", command: "terminal.zoomReset", scope: "global" },
  { key: "ctrl+shift+space", command: "dictation.toggle", scope: "global" },
  { key: "ctrl+shift+l", mac: "cmd+shift+l", command: "lock.now", scope: "global" },
  { key: "shift+/", command: "shortcuts.open", scope: "app" },
  { key: "alt+pageup", mac: "cmd+alt+[", command: "views.previous", scope: "global" },
  { key: "alt+pagedown", mac: "cmd+alt+]", command: "views.next", scope: "global" },
];

export const DEFAULT_KEYBINDINGS_COUNT = DEFAULT_KEYBINDINGS.length;
