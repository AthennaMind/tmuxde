"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

/**
 * A shell command with a copy button.
 *
 * The command itself is selectable text rather than an image or a styled span
 * so that a copy failure — Safari without a user gesture, an insecure origin —
 * still leaves something the reader can select by hand.
 */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      toast.error("Could not copy — select the command instead.");
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 pl-3 pr-1">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-sm text-foreground">
        <span className="select-none text-muted-foreground">$ </span>
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy "${command}"`}
        // 44px. This is the button on the empty state — the very first control
        // a new user is asked to hit, usually on a phone — and it was 36.
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? (
          <Check className="h-4 w-4 text-success" aria-hidden />
        ) : (
          <Copy className="h-4 w-4" aria-hidden />
        )}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}
