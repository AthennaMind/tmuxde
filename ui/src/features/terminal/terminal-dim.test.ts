import { describe, expect, it } from "vitest";
import { brightenDimText } from "./terminal-dim";

const darkTheme = `
.xterm-dom-renderer-owner-1 .xterm-rows { color: #eeeeee; }
.xterm-dom-renderer-owner-1 .xterm-rows .xterm-dim { color: #eeeeee80; }
.xterm-dom-renderer-owner-1 .xterm-fg-5 { color: #aa55cc; }
.xterm-dom-renderer-owner-1 .xterm-fg-5.xterm-dim { color: #aa55cc80; }
.xterm-dom-renderer-owner-1 .xterm-bg-5 { background-color: #aa55cc; }
.xterm-dom-renderer-owner-1 .xterm-selection div { background-color: #eeeeee80; }
`;

function view(css = darkTheme) {
  const renderer = {
    _themeStyleElement: { textContent: css },
    _injectCss(nextCss: string) {
      this._themeStyleElement.textContent = nextCss;
    },
  };
  return {
    renderer,
    terminal: { _core: { _renderService: { _renderer: { value: renderer } } } },
  };
}

describe("mobile dim text", () => {
  it("lifts dim default and ANSI opacity while preserving hues and normal text", () => {
    const { terminal, renderer } = view();
    brightenDimText(terminal);
    expect(renderer._themeStyleElement.textContent).toBe(
      darkTheme
        .replace(".xterm-dim { color: #eeeeee80", ".xterm-dim { color: #eeeeeecc")
        .replace(".xterm-dim { color: #aa55cc80", ".xterm-dim { color: #aa55cccc"),
    );
  });

  it("reapplies after xterm regenerates styles for theme or option changes", () => {
    const { terminal, renderer } = view();
    brightenDimText(terminal);
    renderer._injectCss(darkTheme.replaceAll("eeeeee", "111111"));
    expect(renderer._themeStyleElement.textContent).toContain(".xterm-dim { color: #111111cc; }");
    expect(renderer._themeStyleElement.textContent).toContain(".xterm-rows { color: #111111; }");
  });

  it("leaves opaque RGB colors and cursor or selection styles unchanged", () => {
    const css = `
.xterm-dim { color: #123456; }
.xterm-cursor { color: #12345680; }
.xterm-selection { background-color: #12345680; }
`;
    const { terminal, renderer } = view(css);
    brightenDimText(terminal);
    expect(renderer._themeStyleElement.textContent).toBe(css);
  });

  it("leaves unsupported renderers usable", () => {
    expect(() => brightenDimText({})).not.toThrow();
    expect(() => brightenDimText({ _core: { _renderService: { _renderer: {} } } })).not.toThrow();
  });
});
