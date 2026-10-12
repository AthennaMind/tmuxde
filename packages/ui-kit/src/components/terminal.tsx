import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * Ported from `apps/site/src/components/primitives/terminal.tsx`.
 *
 * A copy rather than an import: the site is a separate Next app with its own
 * build and its own `@/lib/utils` alias. Keeping the markup identical is what
 * makes the app and the site read as one product; the shared half is the token
 * layer in `globals.css`, which both of them now use.
 */

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
  chrome = true,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Traffic-light dots. Off for inline config snippets. */
  chrome?: boolean;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-line bg-surface-sunken",
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
              "font-mono text-[0.8125rem] text-text-subtle",
              chrome && "ms-2",
            )}
          >
            {title}
          </span>
        </div>
      ) : null}
      <div className="overflow-x-auto p-4 font-mono text-[0.875rem] leading-[1.8] sm:p-5">
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

type TokenKind =
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
  | "agent";

const TOKEN_CLASS: Record<TokenKind, string> = {
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
