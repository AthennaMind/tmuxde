import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "./markdown-preview";

const PATH = "/home/u/repo/README.md";

function render(content: string, onOpenPath?: (path: string) => void) {
  return renderToStaticMarkup(createElement(MarkdownPreview, { path: PATH, content, onOpenPath }));
}

describe("MarkdownPreview", () => {
  it("renders hostile input inert", () => {
    const markup = render(
      [
        "<script>alert(1)</script>",
        "",
        '<img src="x" onerror="alert(1)">',
        "",
        "[a](javascript:alert(1)) [b](vbscript:x) [c](data:text/html,x)",
        "",
        '<a href="javascript:alert(2)">d</a>',
      ].join("\n"),
    );
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("onerror");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("vbscript:");
    expect(markup).not.toContain("data:");
    expect(markup).not.toContain("&lt;script");
    expect(markup).toContain("<span>a</span>");
  });

  it("keeps safe inline html and strips the rest", () => {
    const markup = render(
      [
        '<p align="center"><img src="icon.png" width="112" alt="logo"></p>',
        "",
        "<details><summary>More</summary>",
        "",
        "text",
        "",
        "</details>",
        "",
        '<iframe src="https://x.example"></iframe>',
        "",
        "<style>body{display:none}</style>",
        "",
        '<span style="color:red" onclick="x()">s</span> <kbd>Ctrl</kbd>',
      ].join("\n"),
      () => {},
    );
    expect(markup).toContain('<p align="center">');
    expect(markup).toContain('aria-label="logo"');
    expect(markup).toContain("<details><summary>More</summary>");
    expect(markup).toContain("<kbd>Ctrl</kbd>");
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("<style");
    expect(markup).not.toContain("display:none");
    expect(markup).not.toContain("style=");
    expect(markup).not.toContain("onclick");
    expect(markup).toContain("<span>s</span>");
  });

  it("keeps footnote links pointing at their notes", () => {
    const markup = render("Text[^1]\n\n[^1]: The note");
    // Ids carry the sanitizer prefix once. Links say the bare id, and the
    // preview's scroll handler tries both.
    const ref = /<a href="#([^"]+)"[^>]*data-footnote-ref/.exec(markup)?.[1];
    expect(ref).toBe("fn-1");
    expect(markup).toContain('id="user-content-fn-1"');
    expect(markup).not.toContain("user-content-user-content");
    const back = /<a href="#([^"]+)"[^>]*data-footnote-backref/.exec(markup)?.[1];
    expect(back).toBe("fnref-1");
    expect(markup).toContain('id="user-content-fnref-1"');
    expect(markup).toContain('class="footnotes"');
  });

  it("opens relative links through the host", () => {
    const markup = render("[guide](docs/guide.md#usage)", () => {});
    expect(markup).toContain(
      '<button type="button" class="markdown-file-link" title="/home/u/repo/docs/guide.md">guide</button>',
    );
  });

  it("renders file links as text without a host", () => {
    const markup = render("[guide](../other.md)");
    expect(markup).toContain('<span title="/home/u/other.md">guide</span>');
    expect(markup).not.toContain("<button");
  });

  it("keeps external links in a new tab and anchors in the document", () => {
    const markup = render("[e](https://example.com/x) [i](#install)");
    expect(markup).toContain(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">e</a>',
    );
    expect(markup).toContain('<a href="#install">i</a>');
  });

  it("gives headings GitHub style ids and numbers repeats", () => {
    const markup = render("# Hello, World!\n\n## Hello World\n\n### Café ok");
    expect(markup).toContain('<h1 id="hello-world">Hello, World!</h1>');
    expect(markup).toContain('<h2 id="hello-world-1">Hello World</h2>');
    expect(markup).toContain('<h3 id="café-ok">Café ok</h3>');
  });

  it("renders fenced and inline code", () => {
    const markup = render("```ts\nconst a = 1;\n```\n\nUse `x`.");
    expect(markup).toContain('class="markdown-code');
    expect(markup).toContain("<span>ts</span>");
    expect(markup).toContain("const a = 1;");
    expect(markup).toContain('<code class="markdown-inline-code">x</code>');
  });

  it("routes Mermaid fences to diagrams while keeping source available", () => {
    const markup = render("```Mermaid\nflowchart LR\nA --> B\n```\n\n`mermaid`");
    expect(markup).toContain("Rendering diagram");
    expect(markup).toContain("flowchart LR");
    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).toContain('<code class="markdown-inline-code">mermaid</code>');
  });

  it("folds front matter above the body", () => {
    const markup = render("---\ntitle: Hi\n---\n# Body");
    expect(markup).toContain("<summary>Front matter</summary>");
    expect(markup).toContain("title: Hi");
    expect(markup).toContain('<h1 id="body">Body</h1>');
    expect(markup).not.toContain("<hr");
  });

  it("renders task lists, tables and strikethrough from GFM", () => {
    const markup = render("- [x] done\n- [ ] open\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~");
    expect(markup).toContain('<input type="checkbox" disabled="" checked=""/>');
    expect(markup).toContain('<input type="checkbox" disabled=""/>');
    expect(markup).toContain('<div class="markdown-table"><table>');
    expect(markup).toContain("<del>old</del>");
  });

  it("never embeds images straight from the markdown", () => {
    const markup = render("![logo](https://x.example/l.png) ![shot](img/a.png)");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("remote image, not loaded");
    expect(markup).toContain("needs a direct connection");
  });
});
