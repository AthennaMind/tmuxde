export interface FileSelection {
  paths: ReadonlySet<string>;
  anchor: string | null;
}

export const EMPTY_FILE_SELECTION: FileSelection = { paths: new Set(), anchor: null };

export function selectFile(
  selection: FileSelection,
  path: string,
  visible: string[],
  modifiers: { range?: boolean; additive?: boolean },
): FileSelection {
  const visibleSet = new Set(visible);
  const paths = new Set([...selection.paths].filter((key) => visibleSet.has(key)));
  const anchorIndex = visible.indexOf(selection.anchor ?? "");
  const index = visible.indexOf(path);
  if (modifiers.range && anchorIndex >= 0 && index >= 0) {
    const range = visible.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1);
    return {
      paths: new Set(modifiers.additive ? [...paths, ...range] : range),
      anchor: selection.anchor,
    };
  }
  if (modifiers.additive) {
    if (paths.has(path)) paths.delete(path);
    else paths.add(path);
    return { paths, anchor: path };
  }
  return { paths: new Set([path]), anchor: path };
}
