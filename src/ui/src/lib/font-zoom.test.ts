import { beforeEach, describe, expect, it } from "vitest";
import {
  fontZoomSurface,
  notePointerTarget,
  zoomSurfaceOf,
} from "./font-zoom";

/** Just enough of an Element for `closest` on attribute selectors. */
type Fake = {
  attrs: Record<string, string>;
  parent: Fake | null;
  isConnected: boolean;
  closest: (selector: string) => Fake | null;
  getAttribute: (name: string) => string | null;
};

function el(
  attrs: Record<string, string> = {},
  parent: Fake | null = null,
  isConnected = true,
): Fake {
  const node: Fake = {
    attrs,
    parent,
    isConnected,
    closest(selector) {
      const name = selector.slice(1, -1);
      for (let at: Fake | null = node; at; at = at.parent) {
        if (name in at.attrs) return at;
      }
      return null;
    },
    getAttribute: (name) => attrs[name] ?? null,
  };
  return node;
}

const asElement = (fake: Fake) => fake as unknown as Element;

const body = el();
const terminal = el({ "data-zoom-surface": "terminal" }, body);
const terminalInput = el({}, terminal);
const code = el({ "data-zoom-surface": "code" }, body);
const codeLine = el({}, code);
const sidebarButton = el({}, body);

beforeEach(() => notePointerTarget(null));

describe("fontZoomSurface", () => {
  it("sizes the terminal when it has focus", () => {
    expect(fontZoomSurface(asElement(terminalInput), asElement(body))).toBe(
      "terminal",
    );
  });

  it("sizes code when focus is inside a file or diff", () => {
    expect(fontZoomSurface(asElement(codeLine), asElement(body))).toBe("code");
  });

  it("leaves browser zoom alone anywhere else", () => {
    notePointerTarget(asElement(codeLine));
    expect(fontZoomSurface(asElement(sidebarButton), asElement(body))).toBe(
      null,
    );
  });

  it("follows the last click when focus is on the page itself", () => {
    expect(fontZoomSurface(asElement(body), asElement(body))).toBe(null);
    notePointerTarget(asElement(codeLine));
    expect(fontZoomSurface(asElement(body), asElement(body))).toBe("code");
    notePointerTarget(asElement(terminalInput));
    expect(fontZoomSurface(asElement(body), asElement(body))).toBe("terminal");
  });
});

describe("zoomSurfaceOf", () => {
  it("ignores a surface that has left the page", () => {
    const closed = el({ "data-zoom-surface": "code" }, body, false);
    expect(zoomSurfaceOf(asElement(closed))).toBe(null);
  });

  it("ignores the terminal while a tab covers it", () => {
    const hidden = el({ inert: "" }, body);
    const covered = el({ "data-zoom-surface": "terminal" }, hidden);
    expect(zoomSurfaceOf(asElement(el({}, covered)))).toBe(null);
  });
});
