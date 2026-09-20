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
  /**
   * What is actually on screen, as data.
   *
   * Reading this off the DOM is not an option. The WebGL renderer paints into
   * a canvas, so there is no text node to query, and the accessibility tree
   * xterm builds is a different projection with its own rules. The buffer is
   * the only place the rendered truth lives.
   *
   * It is on the handle rather than in a test helper because the thing being
   * asked for -- "what does this terminal currently show" -- is a capability
   * of the terminal, and a helper would have to reach into `_core` from
   * outside to get it.
   */
  inspect: () => TerminalSnapshot;
}

/** One reading of the terminal, taken at a single moment. */
export interface TerminalSnapshot {
  cols: number;
  rows: number;
  cursor: { x: number; y: number };
  /** True while tmux has the alternate buffer up -- `less`, `vim`, `top`. */
  alt: boolean;
  /** Lines of scrollback above the viewport (`buffer.baseY`). */
  scrollback: number;
  /** Top line of the viewport within the buffer (`buffer.viewportY`). */
  viewportY: number;
  /** The viewport's rows, trailing whitespace trimmed, top to bottom. */
  lines: string[];
}

let mounted: TerminalHandle | null = null;

/**
 * The test seam, and why it is compiled out of anything shipped.
 *
 * `e2e/lab` has to read the rendered buffer to diff it against tmux's own
 * `capture-pane`, which is the only check that can see a dropped byte or a
 * wide character measured as one cell. There is no route to the xterm instance
 * from a spec otherwise -- it is a local inside a component.
 *
 * `process.env.NODE_ENV` is inlined by the bundler at build time and the dead
 * branch is then removed, so a production bundle carries neither the property
 * nor the assignment. The lab runs `next dev`, where it is present.
 */
declare global {
  interface Window {
    __mtmuxTerminalHandle?: TerminalHandle | null;
  }
}

export function setTerminalHandle(handle: TerminalHandle | null): void {
  mounted = handle;
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    window.__mtmuxTerminalHandle = handle;
  }
}

export function getTerminalHandle(): TerminalHandle | null {
  return mounted;
}
