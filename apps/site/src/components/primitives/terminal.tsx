import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Hand-authored terminal output.
 *
 * These are illustrations, not real transcripts, so they are plain markup
 * rather than a highlighted code block — which keeps them translatable and
 * lets individual tokens carry semantic colour (`<Tok kind="flag">`).
 *
 * Everything is wrapped in `terminal-lines` so column alignment survives and
 * long lines scroll instead of wrapping.
 */
export function TerminalWindow({
  title,
  children,
  className,
  bodyClassName,
  chrome = true,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Overrides the output type size — the hero fits a QR block in a column. */
  bodyClassName?: string;
  /** Traffic-light dots. Off for inline config snippets. */
  chrome?: boolean;
}) {
  return (
    <div
      className={cn(
        // `terminal-scope` remaps the surface/text tokens inside to the fixed
        // dark terminal palette: a terminal is a dark surface in both schemes,
        // and ANSI colours picked against black are unreadable on paper.
        "terminal-scope overflow-hidden rounded-xl border border-line bg-surface-sunken shadow-lift",
        className,
      )}
    >
      {title ? (
        <div className="flex items-center gap-2 border-b border-line-subtle bg-surface-panel px-3.5 py-2.5">
          {chrome ? (
            <span aria-hidden="true" className="flex gap-1.5">
              <span className="size-2.5 rounded-full bg-signal-failed" />
              <span className="size-2.5 rounded-full bg-signal-blocked" />
              <span className="size-2.5 rounded-full bg-signal-done" />
            </span>
          ) : null}
          <span
            className={cn(
              "font-mono text-[0.875rem] text-text-subtle",
              chrome && "ms-2",
            )}
          >
            {title}
          </span>
        </div>
      ) : null}
      <div
        className={cn(
          "overflow-x-auto p-4 font-mono text-[0.9375rem] leading-[1.8] sm:p-5",
          bodyClassName,
        )}
      >
        <div className="terminal-lines">{children}</div>
      </div>
    </div>
  );
}

/** A single output line. */
export function Line({
  children,
  className,
  tone,
}: {
  children?: ReactNode;
  className?: string;
  tone?: "default" | "muted" | "faint" | "strong";
}) {
  return (
    <div
      className={cn(
        tone === "muted" && "text-text-muted",
        tone === "faint" && "text-text-faint",
        tone === "strong" && "text-text-strong",
        !tone && "text-text",
        className,
      )}
    >
      {children ?? " "}
    </div>
  );
}

/** The `$` shell prompt. Excluded from selection so copied text stays runnable. */
export function Prompt() {
  return (
    <span aria-hidden="true" className="select-none-prompt text-term-prompt">
      ${" "}
    </span>
  );
}

/**
 * Exported because the demo replay renders spans imperatively — it writes
 * class names onto DOM nodes at ~30fps rather than mounting a `<Tok>` per
 * character. Duplicating the map there would let the two colour schemes drift.
 */
export type TokenKind =
  | "path"
  | "value"
  | "comment"
  | "keyword"
  | "flag"
  | "added"
  | "removed"
  | "done"
  | "blocked"
  | "stalled"
  | "failed"
  | "agent"
  /** A row of half-block QR glyphs. Coloured like `value`; the replay also
   *  gives these rows their own leading so the modules come out square. */
  | "qr";

export const TOKEN_CLASS: Record<TokenKind, string> = {
  path: "text-term-path",
  value: "text-term-value",
  comment: "text-term-comment",
  keyword: "text-term-keyword",
  flag: "text-term-flag",
  added: "text-term-added",
  removed: "text-term-removed",
  done: "text-signal-done",
  blocked: "text-signal-blocked",
  stalled: "text-signal-stalled",
  failed: "text-signal-failed",
  agent: "text-signal-agent",
  qr: "text-term-value",
};

/** Semantic colouring for one token of terminal output. */
export function Tok({
  kind,
  children,
}: {
  kind: TokenKind;
  children: ReactNode;
}) {
  return <span className={TOKEN_CLASS[kind]}>{children}</span>;
}

/** The blinking block cursor. */
export function Cursor({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "ms-0.5 inline-block h-[0.9em] w-[0.5em] translate-y-[0.1em] bg-brand animate-blink",
        className,
      )}
    />
  );
}
