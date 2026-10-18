import { describe, expect, it } from "vitest";
import { buildChangeTree } from "./repository-tree";

describe("change tree", () => {
  it("groups paths into sorted folders without losing file identity", () => {
    const entries = ["z.ts", "src/z.ts", "src/deep/a.ts", "src/a.ts", "a.ts"].map((path) => ({
      path,
    }));
    const tree = buildChangeTree(entries);
    expect(tree.map((node) => node.name)).toEqual(["src", "a.ts", "z.ts"]);
    expect(tree[0]?.children?.map((node) => node.name)).toEqual(["deep", "a.ts", "z.ts"]);
    expect(tree[0]?.children?.[0]?.children?.[0]?.entry).toBe(entries[2]);
    expect(tree[0]?.count).toBe(3);
  });

  it("keeps dotfiles, spaces, Unicode and prototype-like names", () => {
    const tree = buildChangeTree([
      { path: "__proto__/constructor.ts" },
      { path: "a folder/你好.ts" },
      { path: ".env" },
    ]);
    expect(tree.find((node) => node.name === "__proto__")?.children?.[0]?.path).toBe(
      "__proto__/constructor.ts",
    );
    expect(tree.find((node) => node.name === "a folder")?.children?.[0]?.name).toBe("你好.ts");
    expect(tree.find((node) => node.name === ".env")?.entry?.path).toBe(".env");
    expect(buildChangeTree([])).toEqual([]);
  });
});
