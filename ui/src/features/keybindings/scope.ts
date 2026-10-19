/**
 * Focus checks for binding scopes. The one place that decides what counts as
 * the terminal and what counts as typing.
 *
 * Both take the element as a parameter, usually `document.activeElement`, so
 * tests can pass plain objects instead of a DOM.
 */

/** The parts of an element these checks read. */
export interface FocusElement {
  tagName: string;
  classList: { contains(token: string): boolean };
  isContentEditable?: boolean;
  /** Input type, for inputs only. */
  type?: string;
}

/** xterm takes keys through a hidden helper textarea. */
const TERMINAL_CLASS = "xterm-helper-textarea";

/**
 * Monaco focus targets. `inputarea` is its textarea. `native-edit-context` is
 * the element it uses where the browser has the EditContext API.
 */
const EDITOR_CLASSES = ["inputarea", "native-edit-context"];

/** Input types that take no text. Typing a letter there does nothing. */
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function terminalHasFocus(element: FocusElement | null | undefined): boolean {
  return !!element && element.classList.contains(TERMINAL_CLASS);
}

/** Text input, textarea, select, contenteditable or Monaco. Never the terminal. */
export function textEntryHasFocus(element: FocusElement | null | undefined): boolean {
  if (!element || terminalHasFocus(element)) return false;
  if (EDITOR_CLASSES.some((name) => element.classList.contains(name))) return true;
  const tag = element.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((element.type ?? "text").toLowerCase());
  return element.isContentEditable === true;
}

export interface FocusState {
  terminal: boolean;
  textEntry: boolean;
}

export function focusStateOf(element: FocusElement | null | undefined): FocusState {
  return { terminal: terminalHasFocus(element), textEntry: textEntryHasFocus(element) };
}
