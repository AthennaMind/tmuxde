import type { WindowLayoutMessage } from "@/protocol";

export type LayoutPreset = WindowLayoutMessage["preset"];

type GlyphProps = { className?: string };

/**
 * One tmux layout preset drawn as its shape.
 *
 * Same 24px grid and 2px stroke as the lucide icons beside it, so the
 * glyphs sit in a row of them without looking heavier or lighter.
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

/** Lines inside the window frame, per preset. The frame spans 3..21 by 4..20. */
const LINES: Record<LayoutPreset, string> = {
  // Three panes side by side.
  "even-horizontal": "M9 4v16M15 4v16",
  // Three panes stacked.
  "even-vertical": "M3 9.5h18M3 14.5h18",
  // A main pane across the top, two below it.
  "main-horizontal": "M3 12h18M12 12v8",
  // A main pane on the left, two stacked on its right.
  "main-vertical": "M12 4v16M12 12h9",
  // A grid of four.
  tiled: "M12 4v16M3 12h18",
};

/** Presets in menu and toolbar order, with their plain names. */
export const LAYOUTS: readonly {
  preset: LayoutPreset;
  label: string;
  icon: React.ComponentType<GlyphProps>;
}[] = (
  [
    ["even-horizontal", "Side by side"],
    ["even-vertical", "Stacked"],
    ["main-horizontal", "Main on top"],
    ["main-vertical", "Main on left"],
    ["tiled", "Tiled"],
  ] as const
).map(([preset, label]) => ({
  preset,
  label,
  icon: ({ className }: GlyphProps) => <Glyph lines={LINES[preset]} className={className} />,
}));
