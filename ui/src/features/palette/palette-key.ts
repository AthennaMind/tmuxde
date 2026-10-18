export type PaletteMode = "commands" | "files" | "terminals";

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/**
 * Ctrl/Cmd+K opens commands, Ctrl/Cmd+P files and Ctrl/Cmd+Shift+F terminal
 * history. xterm skips all three so they reach the window listener instead of
 * the shell. Pressing one while the palette shows another mode switches mode.
 */
export function paletteKeyMode(event: KeyLike): PaletteMode | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (!event.shiftKey && key === "k") return "commands";
  if (!event.shiftKey && key === "p") return "files";
  if (event.shiftKey && key === "f") return "terminals";
  return null;
}

export function isPaletteKey(event: KeyLike): boolean {
  return paletteKeyMode(event) !== null;
}

export function isMacLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad|ipod/i.test(data?.platform ?? navigator.platform ?? "");
}

/** `⌘K` on a Mac, `Ctrl K` elsewhere. */
export function modKey(keys: string): string {
  return isMacLike() ? `⌘${keys}` : `Ctrl ${keys}`;
}
