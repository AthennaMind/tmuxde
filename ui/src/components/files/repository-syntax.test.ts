import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { highlightRepositoryCode } from "./repository-syntax-tokens";
import { RepositorySyntaxLine } from "./repository-syntax";

const restore = (lines: Awaited<ReturnType<typeof highlightRepositoryCode>>) =>
  lines?.map((line) => line.map((token) => token.content).join("")).join("\n");

describe("repository syntax", () => {
  it("highlights real TypeScript tokens and preserves text", async () => {
    const source = 'const message: string = "<script>&";\n\tconsole.log(message);\n';
    const lines = await highlightRepositoryCode("src/main.ts", source, false);
    expect(restore(lines)).toBe(source);
    expect(lines?.[0]?.some((token) => token.color === "var(--term-keyword)")).toBe(true);
    expect(lines?.[0]?.some((token) => token.color === "var(--term-value)")).toBe(true);
  });

  it("keeps multiline comment and template string state", async () => {
    const source = "/* comment\nconst notCode = 12;\n*/\nconst value = `first\nsecond`;";
    const lines = await highlightRepositoryCode("main.ts", source, false);
    expect(restore(lines)).toBe(source);
    expect(lines?.[1]?.every((token) => token.color === "var(--term-comment)")).toBe(true);
    expect(
      lines?.[4]?.some(
        (token) => token.content.includes("second") && token.color === "var(--term-value)",
      ),
    ).toBe(true);
  });

  it("preserves diff markers and isolates removed and added multiline states", async () => {
    const diff = [
      "diff --git a/main.ts b/main.ts",
      "--- a/main.ts",
      "+++ b/main.ts",
      "@@ -1,3 +1,3 @@",
      "-/* old",
      "-comment */",
      "+const value = `new",
      "+template`;",
      " console.log(value);",
      "@@ -20 +20 @@",
      "-const x = 1;",
      "+const x = 2;",
      "\\ No newline at end of file",
    ].join("\n");
    const lines = await highlightRepositoryCode("main.ts", diff, true);
    expect(restore(lines)).toBe(diff);
    expect(lines?.[0]).toEqual([{ content: "diff --git a/main.ts b/main.ts" }]);
    expect(lines?.[3]).toEqual([{ content: "@@ -1,3 +1,3 @@" }]);
    expect(lines?.[5]?.some((token) => token.color === "var(--term-comment)")).toBe(true);
    expect(lines?.[7]?.some((token) => token.color === "var(--term-value)")).toBe(true);
    expect(lines?.[11]?.some((token) => token.color === "var(--term-keyword)")).toBe(true);
  });

  it("preserves CRLF and empty lines", async () => {
    const source = "const value = 1;\r\n\r\n// final\r\n";
    expect(restore(await highlightRepositoryCode("file.ts", source, false))).toBe(source);
  });

  it.each([
    ["file.tsx", 'const element = <p title="hello">Text</p>;'],
    ["file.js", 'const value = "hello";'],
    ["file.jsx", "const element = <p>Text</p>;"],
    ["file.json", '{"value": true}'],
    ["file.css", "body { color: red; }"],
    ["file.html", '<p title="hello">Text</p>'],
    ["file.md", "# Heading\nText"],
    ["file.yml", "name: hello"],
    ["file.sh", 'echo "hello"'],
    ["file.py", 'print("hello")'],
    ["file.go", "package main"],
    ["file.rs", "fn main() {}"],
    ["file.sql", "SELECT 1;"],
    ["file.toml", 'name = "hello"'],
    ["Dockerfile", "FROM node:22"],
  ])("loads local grammar for %s", async (path, source) => {
    expect(restore(await highlightRepositoryCode(path, source, false))).toBe(source);
  });

  it("falls back for unknown and oversized input", async () => {
    expect(await highlightRepositoryCode("data.unknown", "const value = 1", false)).toBeUndefined();
    expect(await highlightRepositoryCode("big.ts", "x".repeat(200_001), false)).toBeUndefined();
    expect(await highlightRepositoryCode("long.ts", "x".repeat(2_001), false)).toBeUndefined();
  });

  it("renders hostile text as escaped content", () => {
    const markup = renderToStaticMarkup(
      createElement(RepositorySyntaxLine, {
        line: '<script>alert("x")</script>',
        tokens: [
          {
            content: '<script>alert("x")</script>',
            color: "var(--term-value)",
          },
        ],
      }),
    );
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
  });
});
