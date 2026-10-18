import { afterEach, describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

function mockDocument() {
  const containers: {
    style: { cssText: string };
    setAttribute: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal("document", {
    body: { append: vi.fn() },
    createElement: () => {
      const container = {
        style: { cssText: "" },
        setAttribute: vi.fn(),
        remove: vi.fn(),
      };
      containers.push(container);
      return container;
    },
  });
  return containers;
}

describe("renderMermaid", () => {
  it("serializes theme changes and produces inert SVG image URLs", async () => {
    const containers = mockDocument();
    const { renderMermaid } = await import("./mermaid");
    let finish!: (value: { svg: string }) => void;
    mermaid.render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mermaid.render.mockResolvedValueOnce({ svg: "<svg>light</svg>" });
    const dark = renderMermaid("flowchart LR\nA --> B", "dark");
    const light = renderMermaid("sequenceDiagram\nA->>B: Hi", "light");
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: "dark",
        securityLevel: "strict",
        htmlLabels: false,
        secure: expect.arrayContaining([
          "securityLevel",
          "dompurifyConfig",
          "themeCSS",
          "htmlLabels",
        ]),
      }),
    );
    finish({ svg: '<svg aria-label="A & B"/>' });
    expect(await dark).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg aria-label="A & B"/>')}`,
    );
    await light;
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "default" }),
    );
    expect(mermaid.render.mock.calls[0]?.[0]).not.toBe(mermaid.render.mock.calls[1]?.[0]);
    expect(containers).toHaveLength(2);
    for (const container of containers) {
      expect(container.remove).toHaveBeenCalledOnce();
    }
  });

  it("cleans up failed renders and lets later diagrams render", async () => {
    const containers = mockDocument();
    const { renderMermaid } = await import("./mermaid");
    mermaid.render.mockRejectedValueOnce(new Error("Invalid syntax"));
    mermaid.render.mockResolvedValueOnce({ svg: "<svg/>" });
    await expect(renderMermaid("invalid", "dark")).rejects.toThrow("Invalid syntax");
    await expect(renderMermaid("graph TD; A-->B", "dark")).resolves.toContain("data:image/svg+xml");
    for (const container of containers) {
      expect(container.remove).toHaveBeenCalledOnce();
    }
  });
});
