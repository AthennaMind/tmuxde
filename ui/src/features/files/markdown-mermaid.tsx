import { useEffect, useState } from "react";
import { useTheme } from "@/shared/use-theme";
import { renderMermaid } from "./mermaid";
import { MarkdownCodeBlock } from "./markdown-code-block";

export function MarkdownMermaid({ source }: { source: string }) {
  const theme = useTheme().resolvedTheme === "light" ? "light" : "dark";
  const [result, setResult] = useState<{
    source: string;
    theme: string;
    url?: string;
    failed?: boolean;
  }>();
  useEffect(() => {
    let cancelled = false;
    void renderMermaid(source, theme).then(
      (url) => {
        if (!cancelled) setResult({ source, theme, url });
      },
      () => {
        if (!cancelled) setResult({ source, theme, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, theme]);
  const current = result?.source === source && result.theme === theme ? result : undefined;

  return (
    <figure className="overflow-hidden rounded-md border bg-surface-sunken">
      {current?.url ? (
        <div className="overflow-x-auto p-3">
          <img src={current.url} alt="Mermaid diagram" className="w-full" />
        </div>
      ) : (
        <p role="status" className="px-3 pt-3 text-sm text-muted-foreground">
          {current?.failed
            ? "Could not render Mermaid diagram. Check source below."
            : "Rendering diagram…"}
        </p>
      )}
      {current?.url ? (
        <details className="px-3 pb-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">Diagram source</summary>
          <MarkdownCodeBlock language="mermaid" source={source} />
        </details>
      ) : (
        <div className="px-3 pb-3">
          <MarkdownCodeBlock language="mermaid" source={source} />
        </div>
      )}
    </figure>
  );
}
