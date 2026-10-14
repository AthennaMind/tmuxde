import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyFailureReason, copyText } from "@/lib/clipboard";
import { useAlertStore } from "@/stores/alert-store";
import { RepositorySyntaxLine, useCodeSyntax } from "./repository-syntax";

/** A fenced block in a Markdown preview: language label, copy, Shiki colors. */
export function MarkdownCodeBlock({
  language,
  source,
}: {
  language?: string;
  source: string;
}) {
  const text = source.replace(/\n$/, "");
  const lines = text.split("\n");
  const tokens = useCodeSyntax(language, text);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <figure className="markdown-code overflow-hidden rounded-md border bg-surface-sunken">
      <div className="flex h-8 items-center justify-between border-b ps-3 pe-1 text-code-meta text-muted-foreground pointer-coarse:h-11">
        <span>{language || "text"}</span>
        <button
          type="button"
          onClick={() => {
            void copyText(text).then((ok) => {
              setCopied(ok);
              // The button says nothing on failure. The alert says why.
              if (!ok)
                useAlertStore.getState().push("error", copyFailureReason());
            });
          }}
          aria-label={copied ? "Copied code" : "Copy code"}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-10"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-3 font-mono text-code">
        <code>
          {lines.map((line, index) => (
            <span key={index} className="block">
              <RepositorySyntaxLine line={line} tokens={tokens?.[index]} />
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}
