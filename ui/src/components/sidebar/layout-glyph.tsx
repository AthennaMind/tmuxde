type GlyphProps = { className?: string };

/**
 * One tmux layout preset drawn as its shape.
 *
 * Same 24px grid and 2px stroke as the lucide icons beside it, so the
 * glyphs sit in a row of them without looking heavier or lighter. The
 * window frame spans 3..21 by 4..20, and `lines` draws inside it.
 */
function Glyph({ lines, className }: { lines: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d={lines} />
    </svg>
  );
}

/** Three panes side by side. */
export function EvenHorizontalGlyph({ className }: GlyphProps) {
  return <Glyph lines="M9 4v16M15 4v16" className={className} />;
}

/** Three panes stacked. */
export function EvenVerticalGlyph({ className }: GlyphProps) {
  return <Glyph lines="M3 9.5h18M3 14.5h18" className={className} />;
}

/** A main pane across the top, two below it. */
export function MainHorizontalGlyph({ className }: GlyphProps) {
  return <Glyph lines="M3 12h18M12 12v8" className={className} />;
}

/** A main pane on the left, two stacked on its right. */
export function MainVerticalGlyph({ className }: GlyphProps) {
  return <Glyph lines="M12 4v16M12 12h9" className={className} />;
}

/** A grid of four. */
export function TiledGlyph({ className }: GlyphProps) {
  return <Glyph lines="M12 4v16M3 12h18" className={className} />;
}
