import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export type RepositorySyntaxToken = { content: string; color?: string };

// Explicit imports keep unused languages and themes out of this viewer.
const grammars = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
};
type Language = keyof typeof grammars;
const extensions: Record<string, Language> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  py: "python",
  go: "go",
  rs: "rust",
  sql: "sql",
  toml: "toml",
};
// Fenced block info strings: extensions above plus the names people type.
const names: Record<string, Language> = {
  ...extensions,
  typescript: "typescript",
  javascript: "javascript",
  shell: "shellscript",
  shellscript: "shellscript",
  console: "shellscript",
  python: "python",
  golang: "go",
  rust: "rust",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  jsonc: "json",
  json5: "json",
  markdown: "markdown",
  yaml: "yaml",
};

/** Shiki language for a fenced block info string such as `ts` or `bash {1}`. */
export function resolveCodeLanguage(info: string | undefined): Language | undefined {
  const word = info?.trim().toLowerCase().split(/[\s{:,]/)[0];
  return word ? names[word] : undefined;
}

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
function getHighlighter() {
  return (highlighter ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine({ forgiving: true }),
    langs: [],
    themes: [
      {
        name: "repository",
        type: "dark",
        colors: {
          "editor.foreground": "var(--foreground)",
          "editor.background": "var(--surface-sunken)",
        },
        tokenColors: [
          {
            scope: ["keyword", "storage"],
            settings: { foreground: "var(--term-keyword)" },
          },
          {
            scope: ["string", "constant", "markup.inline"],
            settings: { foreground: "var(--term-value)" },
          },
          {
            scope: [
              "entity",
              "support",
              "variable.parameter",
              "markup.heading",
            ],
            settings: { foreground: "var(--term-path)" },
          },
          {
            scope: ["comment"],
            settings: { foreground: "var(--term-comment)" },
          },
        ],
      },
    ],
  }));
}

/** Bound tokenization cost before loading any grammar. */
export async function highlightRepositoryCode(
  path: string,
  content: string,
  isDiff: boolean,
): Promise<RepositorySyntaxToken[][] | undefined> {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const language =
    name === "dockerfile" || name.startsWith("dockerfile.")
      ? "dockerfile"
      : extensions[name.split(".").pop() ?? ""];
  if (!language) return undefined;
  const lines = content.split("\n");
  if (!withinBounds(content, lines)) return undefined;
  try {
    const highlighter = await loadLanguage(language);
    const tokenize = (source: string) =>
      tokenizeWith(highlighter, language, source);
    if (!isDiff) {
      const tokens = tokenize(content);
      // TextMate normalizes line endings. Keep original preview text exact.
      return lines.map((line, index) => restoreLine(line, tokens[index]));
    }
    const result = lines.map(
      (content) => [{ content }] as RepositorySyntaxToken[],
    );
    let oldLines: { index: number; content: string }[] = [];
    let newLines: { index: number; content: string }[] = [];
    const flush = () => {
      for (const entries of [oldLines, newLines]) {
        if (!entries.length) continue;
        const tokens = tokenize(
          entries.map((entry) => entry.content).join("\n"),
        );
        entries.forEach((entry, index) => {
          const marker = lines[entry.index]!.slice(0, 1);
          result[entry.index] = [
            { content: marker },
            ...restoreLine(entry.content, tokens[index]),
          ];
        });
      }
      oldLines = [];
      newLines = [];
    };
    let inHunk = false;
    lines.forEach((line, index) => {
      if (line.startsWith("@@") || line.startsWith("diff ")) {
        flush();
        inHunk = line.startsWith("@@ ");
      } else if (inHunk && /^[ +-]/.test(line)) {
        const entry = { index, content: line.slice(1) };
        if (line[0] !== "+") oldLines.push(entry);
        if (line[0] !== "-") newLines.push(entry);
      } else if (!line.startsWith("\\")) {
        flush();
        inHunk = false;
      }
    });
    flush();
    return result;
  } catch {
    return undefined;
  }
}

/** Fenced code in a Markdown preview. Same grammars, theme and bounds. */
export async function highlightCodeByLanguage(
  info: string,
  source: string,
): Promise<RepositorySyntaxToken[][] | undefined> {
  const language = resolveCodeLanguage(info);
  if (!language) return undefined;
  const lines = source.split("\n");
  if (!withinBounds(source, lines)) return undefined;
  try {
    const highlighter = await loadLanguage(language);
    const tokens = tokenizeWith(highlighter, language, source);
    return lines.map((line, index) => restoreLine(line, tokens[index]));
  } catch {
    return undefined;
  }
}

function withinBounds(content: string, lines: string[]) {
  return (
    content.length <= 200_000 &&
    lines.length <= 4_000 &&
    !lines.some((line) => line.length > 2_000)
  );
}

async function loadLanguage(language: Language): Promise<Highlighter> {
  const highlighter = await getHighlighter();
  if (!highlighter.getLoadedLanguages().includes(language)) {
    await highlighter.loadLanguage(await grammars[language]());
  }
  return highlighter;
}

function tokenizeWith(
  highlighter: Highlighter,
  language: Language,
  source: string,
): RepositorySyntaxToken[][] {
  return highlighter
    .codeToTokens(source, { lang: language, theme: "repository" })
    .tokens.map((line) =>
      line.map(({ content, color }) => ({ content, color })),
    );
}

function restoreLine(
  line: string,
  tokens?: RepositorySyntaxToken[],
): RepositorySyntaxToken[] {
  const text = tokens?.map((token) => token.content).join("");
  if (text === line) return tokens!;
  if (text === line.replace(/\r$/, "")) return [...tokens!, { content: "\r" }];
  return [{ content: line }];
}
