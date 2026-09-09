"use client";

import type React from "react";

import { QrCode } from "@/components/primitives/qr-code";
import { TOKEN_CLASS } from "@/components/primitives/terminal";
import type { Frame, Row } from "@/lib/demo/types";
import { cn } from "@/lib/utils";

/**
 * The laptop half: `cast.rows` fixed rows of spans.
 *
 * `frameAt` already pads every frame to exactly that many rows, and the height
 * is pinned to `rows × --row-h` so it cannot drift with the content.
 *
 * The one thing that is not text is the QR. The cast carries it as the
 * half-block glyphs `qrcode-terminal` prints, which is honest about what lands
 * in a real scrollback but wrong in a browser twice over: the modules are only
 * square when the line box is exactly twice the character advance, and the
 * terminal's polarity (light modules drawn bright, dark ones left as
 * background) is a coin flip across scanner apps. So the glyph rows keep their
 * geometry — they still set the block's width and height — and the real code
 * is drawn over them as an SVG, the same one the hero shows. Same bytes, no
 * shear, and it scans.
 */

const TONE_CLASS = {
  default: "text-text",
  muted: "text-text-muted",
  faint: "text-text-faint",
  strong: "text-text-strong",
} as const;

/** Rows of the QR block: leading whitespace, then the glyph run. */
const isQrRow = (row: Row) => row.some((span) => span.kind === "qr");

export function LaptopViewport({
  frame,
  showCursor,
  className,
}: {
  frame: Frame;
  showCursor: boolean;
  className?: string;
}) {
  const firstQr = frame.rows.findIndex(isQrRow);
  const qrRowCount = frame.rows.filter(isQrRow).length;

  // Where to hang the overlay, in character cells, read off the glyph run
  // itself so the indent in `cast.ts` stays the single source of truth.
  const qrSpan =
    firstQr === -1
      ? undefined
      : frame.rows[firstQr]!.find((span) => span.kind === "qr");
  const qrIndent = qrSpan
    ? qrSpan.text.length - qrSpan.text.trimStart().length
    : 0;
  const qrCols = qrSpan ? qrSpan.text.length - qrIndent : 0;

  return (
    <div
      className={cn(
        "relative overflow-hidden font-mono text-[0.75rem] leading-(--row-h) sm:text-[0.8125rem]",
        className,
      )}
      // Height is `rows × row height`, pinned rather than left to the sum of
      // the line boxes: the QR rows carry a leading of their own, so without
      // this the viewport would shrink for the seconds the banner is on screen
      // and shove the rest of the page around.
      style={
        {
          "--row-h": "1.55",
          height: `calc(1.55em * ${frame.rows.length})`,
        } as React.CSSProperties
      }
      // The rows mutate ~30 times a second. Handing that to a screen reader is
      // hostile; the section carries one `sr-only` description instead.
      aria-hidden="true"
    >
      {frame.rows.map((row, y) => {
        const qr = isQrRow(row);
        return (
          <div
            key={y}
            className={cn(
              "whitespace-pre",
              // Two modules per line box, so the block ends up square.
              qr && "relative leading-[1.2]",
            )}
          >
            {row.length === 0 ? (
              " "
            ) : (
              <>
                {row.map((span, x) => (
                  <span
                    key={x}
                    className={cn(
                      span.kind
                        ? TOKEN_CLASS[span.kind]
                        : TONE_CLASS[span.tone ?? "default"],
                      // Invisible, not absent: the glyphs still reserve the
                      // columns the overlay is measured against.
                      span.kind === "qr" && "invisible",
                    )}
                  >
                    {span.text}
                  </span>
                ))}
                {showCursor && frame.cursor?.row === y && (
                  <span className="ms-0.5 inline-block h-[0.9em] w-[0.5em] translate-y-[0.1em] bg-brand animate-blink" />
                )}
              </>
            )}
            {y === firstQr ? (
              <QrCode
                label=""
                preserveAspectRatio="xMinYMin meet"
                className="absolute top-0"
                style={{
                  insetInlineStart: `${qrIndent}ch`,
                  width: `${qrCols}ch`,
                  height: `calc(1.2em * ${qrRowCount})`,
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
