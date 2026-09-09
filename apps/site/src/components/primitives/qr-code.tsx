import type React from "react";

import { QR_MATRIX } from "@/lib/demo/qr-glyph";
import { cn } from "@/lib/utils";

/**
 * The real QR from `qr-glyph.ts`, drawn as an SVG.
 *
 * Squares, not half-blocks: a terminal draws two modules per character cell,
 * and the browser has no reason to inherit that constraint — at any line
 * height but the exact one it assumes, half-blocks shear and the code stops
 * scanning. A path of unit squares on a `viewBox` grid is always crisp and
 * always square.
 *
 * Polarity is the printed one — dark modules on a light plaque — rather than
 * the terminal's inverted one, because this is the form every scanner handles
 * and every reader recognises.
 *
 * Colours come from `--text-strong` and `--surface-sunken`, which is only the
 * right way round inside `terminal-scope`, where those resolve to near-white
 * and near-black in both schemes. Keep it inside a `TerminalWindow`.
 */

/** Quiet zone, in modules. The spec asks for four; three still scans and the
 *  block stays readable at hero size. */
const QUIET = 3;

export function QrCode({
  label,
  className,
  style,
  preserveAspectRatio,
}: {
  /**
   * Describes where the code leads. Translated — it is user-facing text.
   * Empty inside an `aria-hidden` container, where a label is noise: the
   * replay's viewport is hidden from screen readers wholesale.
   */
  label: string;
  className?: string;
  style?: React.CSSProperties;
  /** Left-aligns the code when its box is not square. */
  preserveAspectRatio?: string;
}) {
  const modules = QR_MATRIX.length;
  const span = modules + QUIET * 2;

  // One path rather than 300 rects: same pixels, a fraction of the DOM.
  const path = QR_MATRIX.flatMap((row, y) =>
    [...row].map((cell, x) =>
      cell === "1" ? `M${x + QUIET} ${y + QUIET}h1v1h-1z` : "",
    ),
  ).join("");

  return (
    <svg
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      viewBox={`0 0 ${span} ${span}`}
      preserveAspectRatio={preserveAspectRatio}
      shapeRendering="crispEdges"
      className={cn("rounded-sm", className)}
      style={style}
    >
      <rect width={span} height={span} className="fill-text-strong" />
      <path d={path} className="fill-surface-sunken" />
    </svg>
  );
}
