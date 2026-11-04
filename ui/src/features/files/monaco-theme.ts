import { useEffect } from "react";
import * as monaco from "monaco-editor";
import { useTheme } from "@/shared/use-theme";

const THEME = "tmuxde";

/** Monaco needs hex colors. Resolve app tokens through browser color conversion. */
export function applyMonacoTheme(): string {
  const styles = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  const color = (token: string): string => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = styles.getPropertyValue(token).trim();
    context.fillRect(0, 0, 1, 1);
    return `#${Array.from(context.getImageData(0, 0, 1, 1).data)
      .slice(0, 3)
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
  };
  const background = color("--background");
  const foreground = color("--foreground");
  const muted = color("--muted-foreground");
  const border = color("--border");
  const accent = color("--accent");
  const brand = color("--primary");
  const panel = color("--popover");

  monaco.editor.defineTheme(THEME, {
    base: document.documentElement.classList.contains("dark") ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "", foreground },
      { token: "comment", foreground: color("--term-comment") },
      { token: "keyword", foreground: color("--term-keyword") },
      { token: "string", foreground: color("--term-value") },
      { token: "number", foreground: color("--term-value") },
      { token: "type", foreground: color("--term-path") },
      { token: "delimiter", foreground },
    ],
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
      "editorGutter.background": background,
      "editorLineNumber.foreground": muted,
      "editorLineNumber.activeForeground": foreground,
      "editorCursor.foreground": brand,
      "editor.lineHighlightBackground": color("--surface-raised"),
      "editor.lineHighlightBorder": color("--surface-raised"),
      "editor.selectionBackground": accent,
      "editor.inactiveSelectionBackground": `${accent}99`,
      "editor.selectionHighlightBackground": `${brand}22`,
      "editor.findMatchBackground": `${brand}44`,
      "editor.findMatchHighlightBackground": `${brand}22`,
      "editorWhitespace.foreground": border,
      "editorIndentGuide.background1": border,
      "editorIndentGuide.activeBackground1": muted,
      "editorWidget.background": panel,
      "editorWidget.foreground": foreground,
      "editorWidget.border": border,
      "editorHoverWidget.background": panel,
      "editorHoverWidget.foreground": foreground,
      "editorHoverWidget.border": border,
      "editorSuggestWidget.background": panel,
      "editorSuggestWidget.foreground": foreground,
      "editorSuggestWidget.border": border,
      "editorSuggestWidget.selectedBackground": accent,
      "editorOverviewRuler.background": background,
      "diffEditor.insertedTextBackground": `${color("--term-added")}22`,
      "diffEditor.removedTextBackground": `${color("--term-removed")}22`,
      "diffEditor.insertedLineBackground": `${color("--term-added")}11`,
      "diffEditor.removedLineBackground": `${color("--term-removed")}11`,
      "diffEditor.diagonalFill": border,
      "scrollbarSlider.background": `${muted}33`,
      "scrollbarSlider.hoverBackground": `${muted}55`,
      "scrollbarSlider.activeBackground": `${muted}77`,
      focusBorder: brand,
    },
  });
  monaco.editor.setTheme(THEME);
  return THEME;
}

export function useMonacoTheme(): string {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    applyMonacoTheme();
  }, [resolvedTheme]);
  return THEME;
}
