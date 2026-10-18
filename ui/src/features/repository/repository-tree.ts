export type ChangeNode<T> = {
  name: string;
  path: string;
  count: number;
  entry?: T;
  children?: ChangeNode<T>[];
};

export function buildChangeTree<T extends { path: string }>(entries: T[]): ChangeNode<T>[] {
  type Branch = { node: ChangeNode<T>; folders: Map<string, Branch> };
  const root: Branch = {
    node: { name: "", path: "", count: 0, children: [] },
    folders: new Map(),
  };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let branch = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const name = parts[index]!;
      let next = branch.folders.get(name);
      if (!next) {
        next = {
          node: {
            name,
            path: parts.slice(0, index + 1).join("/"),
            count: 0,
            children: [],
          },
          folders: new Map(),
        };
        branch.folders.set(name, next);
        branch.node.children!.push(next.node);
      }
      next.node.count++;
      branch = next;
    }
    branch.node.children!.push({
      name: parts.at(-1)!,
      path: entry.path,
      count: 1,
      entry,
    });
  }
  const sort = (nodes: ChangeNode<T>[]): ChangeNode<T>[] => {
    nodes.sort(
      (a, b) =>
        Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.name.localeCompare(b.name),
    );
    nodes.forEach((node) => {
      if (node.children) sort(node.children);
    });
    return nodes;
  };
  return sort(root.node.children!);
}
