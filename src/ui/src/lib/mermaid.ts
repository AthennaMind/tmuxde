let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

/** Serialize configuration and rendering because Mermaid shares global state. */
export function renderMermaid(source: string, theme: "light" | "dark") {
  const render = queue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
      htmlLabels: false,
      // Diagram directives cannot relax safety or inject custom CSS.
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "dompurifyConfig",
        "theme",
        "themeCSS",
        "themeVariables",
        "fontFamily",
        "htmlLabels",
        "flowchart",
      ],
      flowchart: { htmlLabels: false },
    });
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden";
    container.setAttribute("aria-hidden", "true");
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(
        `markdown-mermaid-${++nextId}`,
        source,
        container,
      );
      // SVG images cannot run scripts, load external assets or style app UI.
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } finally {
      container.remove();
    }
  });
  // Failed diagrams must not block later renders.
  queue = render.catch(() => {});
  return render;
}
