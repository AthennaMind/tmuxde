/**
 * Registry for the mounted terminal's imperative handle.
 *
 * The mobile keyboard toolbar lives in the app shell's footer, well outside the
 * tree that owns the terminal ref, so it needs the same kind of escape hatch as
 * `getRelayClient()` — there is only ever one mounted terminal. This lives in
 * its own module (rather than in terminal-view) so consumers don't drag xterm
 * into their bundle: xterm touches `self` at module scope and breaks the
 * server render.
 */
export interface TerminalHandle {
  search: (term: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  /** Current xterm selection, or "" when nothing is selected. */
  getSelection: () => string;
  /**
   * Drop any selection.
   *
   * The search addon calls `terminal.select()` on every hit and nothing ever
   * undid it, so a single search on a phone left a permanent selection — which
   * the old swipe handler read as "the user is selecting text" and refused to
   * swipe for, forever. The gesture surface now clears it the moment a drag is
   * proven to be a drag; a tap never claims, so a selection about to be copied
   * is left alone.
   */
  clearSelection: () => void;
  /**
   * Height of one terminal row in CSS pixels, for turning a drag into lines.
   *
   * Zero when the renderer has not measured yet, which the caller treats as
   * "fall back to an estimate" rather than as "do not scroll".
   */
  getCellHeightPx: () => number;
  /**
   * Re-fit, rebuild the character atlas and repaint every row.
   *
   * The renderer caches cell metrics and (with WebGL) a glyph atlas sized in
   * device pixels. Both are built once, at whatever devicePixelRatio and
   * layout happened to be current — so a DPR change, a CSS filter applied
   * while the tab was hidden, or a tab swap that never triggered a refit all
   * leave a canvas whose backing store no longer matches its box. The browser
   * then scales it, which is the blur. Nothing in xterm invalidates that on
   * its own; this is the call that does.
   */
  redraw: () => void;
}

let mounted: TerminalHandle | null = null;

export function setTerminalHandle(handle: TerminalHandle | null): void {
  mounted = handle;
}

export function getTerminalHandle(): TerminalHandle | null {
  return mounted;
}
