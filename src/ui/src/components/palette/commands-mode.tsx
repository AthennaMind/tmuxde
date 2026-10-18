import { Command } from "cmdk";
import { Terminal } from "lucide-react";
import { matchPalette, type Range } from "@/lib/palette-match";
import { modKey } from "@/lib/palette-key";
import { sendCommand } from "@/lib/send-command";
import {
  ContextLine, GROUP_CLASS, LIST_CLASS, PaletteEmpty, PaletteFooter, PaletteRow, usePalette, type PaletteItem,
} from "./palette-primitives";
import { useCanType, usePaletteCommands, useWorkspaceContext, type PaletteGroup } from "./use-palette-commands";

interface Visible {
  group: PaletteGroup;
  items: { item: PaletteItem; ranges: Range[] }[];
}

/** Keep matching items, best first within each group. Group order is fixed. */
export function filterGroups(groups: PaletteGroup[], query: string): Visible[] {
  const visible: Visible[] = [];
  for (const group of groups) {
    const scored = group.items.flatMap((item, index) => {
      const match = matchPalette(query, item.label, item.keywords);
      return match ? [{ item, ranges: match.ranges, score: match.score, index }] : [];
    });
    if (!scored.length) continue;
    if (query.trim()) scored.sort((a, b) => b.score - a.score || a.index - b.index);
    visible.push({ group, items: scored.map(({ item, ranges }) => ({ item, ranges })) });
  }
  return visible;
}

export function CommandsMode() {
  const { query, finish } = usePalette();
  const groups = usePaletteCommands(query);
  const canType = useCanType();
  const context = useWorkspaceContext();
  const visible = filterGroups(groups, query);
  const total = visible.reduce((sum, entry) => sum + entry.items.length, 0);
  const command = query.trim();
  const run: PaletteItem | null = canType && command ? {
    id: "shell:run",
    label: `Run ${command}`,
    detail: "Send to the active terminal",
    icon: <Terminal />,
    mono: true,
    shortcut: [modKey("↵")],
    run: () => { if (sendCommand(command)) finish("terminal"); },
  } : null;

  return (
    <>
      <Command.List className={LIST_CLASS} aria-label="Commands">
        {total === 0 && !run && (
          <PaletteEmpty>{command ? `No commands match “${command}”.` : "Nothing to do here yet."}</PaletteEmpty>
        )}
        {visible.map(({ group, items }) => (
          <Command.Group key={group.id} heading={group.heading} className={GROUP_CLASS}>
            {items.map(({ item, ranges }) => <PaletteRow key={item.id} item={item} ranges={ranges} />)}
          </Command.Group>
        ))}
        {run && (
          <Command.Group heading="Shell" className={GROUP_CLASS}>
            <PaletteRow item={run} />
          </Command.Group>
        )}
      </Command.List>
      <PaletteFooter
        left={<ContextLine parts={[context.machine, context.session, context.folder]} />}
        right={run ? [["↵", "select"], [modKey("↵"), "run"]] : [["↑↓", "move"], ["↵", "select"], ["esc", "close"]]}
      />
      <div role="status" aria-live="polite" className="sr-only">
        {command ? `${total + (run ? 1 : 0)} results` : ""}
      </div>
    </>
  );
}
