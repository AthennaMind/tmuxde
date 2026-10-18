import { describe, expect, it } from "vitest";
import {
  codeBlockLanguage,
  createSlugger,
  hastText,
  isMarkdownPath,
  resolveMarkdownHref,
  resolvePath,
  splitFrontMatter,
} from "./markdown";

describe("isMarkdownPath", () => {
  it.each([
    ["/repo/README.md", true],
    ["/repo/docs/guide.markdown", true],
    ["/repo/NOTES.MD", true],
    ["/repo/page.mdx", false],
    ["/repo/.md", false],
    ["/repo/md", false],
    ["/repo/main.ts", false],
  ])("%s -> %s", (path, expected) => {
    expect(isMarkdownPath(path)).toBe(expected);
  });
});

describe("splitFrontMatter", () => {
  it("splits yaml fences off the body", () => {
    expect(splitFrontMatter("---\ntitle: Hi\ntags: [a]\n---\n# Body\n")).toEqual({
      frontMatter: "title: Hi\ntags: [a]",
      body: "# Body\n",
    });
  });
  it("accepts a yaml document end marker and CRLF", () => {
    expect(splitFrontMatter("---\r\na: 1\r\n...\r\ntext")).toEqual({
      frontMatter: "a: 1",
      body: "text",
    });
  });
  it("accepts an empty block", () => {
    expect(splitFrontMatter("---\n---\nbody")).toEqual({
      frontMatter: "",
      body: "body",
    });
  });
  it.each(["# Title\n---\n", "text\n---\na: 1\n---\n", "----\na\n---\n"])(
    "leaves %j alone",
    (content) => {
      expect(splitFrontMatter(content)).toEqual({
        frontMatter: null,
        body: content,
      });
    },
  );
});

describe("resolveMarkdownHref", () => {
  const file = "/home/u/repo/docs/guide.md";
  it.each([
    ["#install", { kind: "anchor", id: "install" }],
    ["#with%20space", { kind: "anchor", id: "with space" }],
    ["https://example.com/x", { kind: "external", href: "https://example.com/x" }],
    ["HTTP://EXAMPLE.COM", { kind: "external", href: "HTTP://EXAMPLE.COM" }],
    ["mailto:a@b.c", { kind: "external", href: "mailto:a@b.c" }],
    ["intro.md", { kind: "file", path: "/home/u/repo/docs/intro.md", fragment: null }],
    ["./img/a%20b.png", { kind: "file", path: "/home/u/repo/docs/img/a b.png", fragment: null }],
    ["../README.md#usage", { kind: "file", path: "/home/u/repo/README.md", fragment: "usage" }],
    ["/home/u/other/file.md?x=1", { kind: "file", path: "/home/u/other/file.md", fragment: null }],
    ["../../../../../etc/passwd", { kind: "unsupported" }],
    ["javascript:alert(1)", { kind: "unsupported" }],
    ["JavaScript:alert(1)", { kind: "unsupported" }],
    ["data:text/html,hi", { kind: "unsupported" }],
    ["vbscript:x", { kind: "unsupported" }],
    ["file:///etc/passwd", { kind: "unsupported" }],
    ["//evil.example/x", { kind: "unsupported" }],
    ["..\\..\\x", { kind: "unsupported" }],
    ["", { kind: "unsupported" }],
    ["#", { kind: "unsupported" }],
    ["?only=query", { kind: "unsupported" }],
  ])("%s", (href, expected) => {
    expect(resolveMarkdownHref(file, href)).toEqual(expected);
  });
});

describe("resolvePath", () => {
  it.each([
    ["/a/b", "c", "/a/b/c"],
    ["/a/b", "./c/../d", "/a/b/d"],
    ["/a/b", "../c", "/a/c"],
    ["/a", "../../c", null],
    ["/a/b", "/x/y", "/x/y"],
    ["/", "c", "/c"],
  ])("%s + %s", (base, target, expected) => {
    expect(resolvePath(base, target)).toBe(expected);
  });
});

describe("createSlugger", () => {
  it("matches GitHub style ids and numbers repeats", () => {
    const slug = createSlugger();
    expect(slug("Hello, World!")).toBe("hello-world");
    expect(slug("Hello World")).toBe("hello-world-1");
    expect(slug("  Spaces   inside ")).toBe("spaces-inside");
    expect(slug("snake_case and-dash")).toBe("snake_case-and-dash");
    expect(slug("Ünïcödé ok")).toBe("ünïcödé-ok");
    expect(slug("!!!")).toBe("section");
    expect(slug("???")).toBe("section-1");
  });
});

describe("hastText", () => {
  it("joins nested text", () => {
    expect(
      hastText({
        type: "element",
        children: [
          { type: "text", value: "a " },
          { type: "element", children: [{ type: "text", value: "b" }] },
          { type: "comment", value: "ignored" },
        ],
      }),
    ).toBe("a b");
  });
});

describe("codeBlockLanguage", () => {
  it.each([
    ["language-ts", "ts"],
    [["language-Bash", "other"], "bash"],
    ["other language-c++", "c++"],
    ["nope", undefined],
    [undefined, undefined],
  ])("%j -> %j", (className, expected) => {
    expect(codeBlockLanguage(className)).toBe(expected);
  });
});
