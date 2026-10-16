import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Ellipsis } from "lucide-react";
import type { PaneInfo } from "@/protocol";
import { PanePeek, usePanePeek } from "./pane-peek";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type Icon = React.ComponentType<{ className?: string }>;

export interface TreeAction {
  label: string;
  icon?: Icon;
  onSelect: () => void;
  destructive?: boolean;
  /** Draw a separator above this item. */
  separated?: boolean;
  /** Items of a submenu. They nest, so a submenu item can open its own. */
  submenu?: TreeAction[];
  /** Key that does the same on the focused row or cell, shown at the item end. */
  shortcut?: string;
  /**
   * Inline action that only shows while the tree is wide enough, a
   * `@container/tree` of 15.5rem and up. The menu keeps it at every width.
   */
  wide?: boolean;
}

/**
 * Feedback while a pane drag is over a row. `join` lights the half the pane
 * would land on: the left half joins beside the active pane, the right half
 * below it. `break` lights the whole row.
 */
export type RowDrop = { kind: "join"; direction: "h" | "v" } | { kind: "break" };

export interface TreeRowModel {
  key: string;
  parentKey: string | null;
  depth: number;
  label: string;
  /** Leading index, in tabular figures. */
  prefix?: string;
  icon?: React.ReactNode;
  /** Muted text after the label. */
  secondary?: string;
  /** Folder or context on a second line, used by terminal rows. */
  description?: string;
  title?: string;
  /** Trailing details. Hidden while hover actions show. */
  meta?: React.ReactNode;
  expandable?: boolean;
  expanded?: boolean;
  /** The one highlighted row. */
  selected?: boolean;
  /** On the path to the selected row. */
  current?: boolean;
  /** A switch is on the wire and not confirmed yet. */
  pending?: boolean;
  muted?: boolean;
  activate: () => void;
  toggle?: () => void;
  doubleClick?: () => void;
  rename?: { value: string; submit: (name: string) => void };
  remove?: () => void;
  inline?: TreeAction[];
  menu?: TreeAction[];
  drop?: RowDrop;
  /** Single-pane windows use the same preview as split-pane cells. */
  peek?: { pane: PaneInfo; machineId: string; session: string };
}

/**
 * Arrow keys, Home and End move focus between rows of one tree.
 *
 * A row that handles the key itself calls `preventDefault`, and the tree
 * leaves it alone. The pane grid does that to move between its cells.
 */
export function useTreeKeyboard() {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (!target.dataset.treeRow || !ref.current) return;
    const rows = Array.from(
      ref.current.querySelectorAll<HTMLElement>("[data-tree-row]"),
    );
    const index = rows.indexOf(target);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : index + (event.key === "ArrowDown" ? 1 : -1);
    const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
    if (!row) return;
    event.preventDefault();
    row.focus();
  }, []);
  return { ref, onKeyDown };
}

function focusRow(from: HTMLElement, key: string) {
  const tree = from.closest("[data-tree]");
  tree
    ?.querySelector<HTMLElement>(`[data-tree-row="${CSS.escape(key)}"]`)
    ?.focus();
}

/**
 * One row of a sidebar tree.
 *
 * The row is a button for its main action with sibling buttons for the rest,
 * not an ARIA treeitem. A treeitem cannot hold buttons, and these rows need
 * them. Chevron and hover buttons are skipped by Tab. Keyboard reaches the
 * same actions through arrows, F2, Delete and the context menu key.
 */
export function TreeRow({
  row,
  tabStop,
  onFocusRow,
  menuOpen,
  onMenuOpenChange,
  renaming,
  onRenameStart,
  onRenameEnd,
}: {
  row: TreeRowModel;
  tabStop: boolean;
  onFocusRow: (key: string) => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  renaming: boolean;
  onRenameStart: () => void;
  onRenameEnd: () => void;
}) {
  const indent = 4 + row.depth * 14;
  const mainRef = useRef<HTMLButtonElement>(null);
  const menu = row.menu ?? [];
  const inline = row.inline ?? [];
  const preview = row.peek;
  const peek = usePanePeek(!menuOpen && !renaming && !!preview);

  const handleKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "p":
      case "P":
        if (!peek.enabled || !preview || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        peek.toggleKey(preview.pane, event.currentTarget);
        break;
      case "ArrowRight":
        if (!row.expandable) return;
        event.preventDefault();
        if (!row.expanded) row.toggle?.();
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (row.expandable && row.expanded) row.toggle?.();
        else if (row.parentKey) focusRow(event.currentTarget, row.parentKey);
        break;
      case "F2":
        if (!row.rename) return;
        event.preventDefault();
        onRenameStart();
        break;
      case "Delete":
        if (!row.remove) return;
        event.preventDefault();
        row.remove();
        break;
      case "ContextMenu":
        if (!menu.length) return;
        event.preventDefault();
        onMenuOpenChange(true);
        break;
      case "F10":
        if (!event.shiftKey || !menu.length) return;
        event.preventDefault();
        onMenuOpenChange(true);
        break;
    }
  };

  return (
    <div
      className={cn(
        "group/row relative flex items-center gap-0.5 rounded-md pe-0.5 text-[13px]",
        row.description ? "min-h-11 py-1" : "h-7",
        "has-[[data-tree-row]:focus-visible]:ring-2 has-[[data-tree-row]:focus-visible]:ring-ring",
        row.selected
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-accent/50",
        row.muted && !row.selected && "text-muted-foreground",
        row.pending && "opacity-70",
      )}
      style={{ paddingInlineStart: indent }}
      data-row-key={row.key}
      {...(preview ? peek.hover(preview.pane) : {})}
      onPointerDownCapture={(event) => {
        const target = event.target as Node;
        if (event.currentTarget.contains(target) && !mainRef.current?.contains(target)) peek.close();
      }}
      onContextMenu={(event) => {
        if (preview && mainRef.current?.contains(event.target as Node) && peek.contextMenu(event, preview.pane)) return;
        if (!menu.length) return;
        event.preventDefault();
        peek.close();
        onMenuOpenChange(true);
      }}
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        {row.expandable && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={row.toggle}
            className="flex h-5 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-[rotate] duration-150",
                row.expanded && "rotate-90",
              )}
            />
          </button>
        )}
      </span>

      {renaming && row.rename ? (
        <RenameInput
          initial={row.rename.value}
          onDone={(value) => {
            onRenameEnd();
            const trimmed = value?.trim();
            if (trimmed && trimmed !== row.rename?.value)
              row.rename?.submit(trimmed);
          }}
        />
      ) : (
        <button
          ref={mainRef}
          type="button"
          data-tree-row={row.key}
          tabIndex={tabStop ? 0 : -1}
          aria-current={row.selected ? "true" : undefined}
          aria-expanded={row.expandable ? row.expanded : undefined}
          title={peek.enabled ? undefined : row.title ?? row.label}
          aria-keyshortcuts={peek.enabled ? "P" : undefined}
          onFocus={() => onFocusRow(row.key)}
          onPointerDown={(event) => {
            if (preview) peek.pointerDown(event, preview.pane);
          }}
          onPointerMove={peek.pointerMove}
          onPointerUp={peek.pointerUp}
          onPointerCancel={peek.pointerUp}
          onClick={() => {
            if (!peek.consumeClick()) row.activate();
          }}
          onDoubleClick={row.doubleClick}
          onKeyDown={handleKey}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md ps-0.5 text-start outline-none"
        >
          {row.prefix !== undefined && (
            <span className="min-w-3 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
              {row.prefix}
            </span>
          )}
          {row.icon}
          <span className={cn("min-w-0", row.description ? "flex flex-1 flex-col gap-0.5" : "shrink")}>
            <span className={cn("block truncate", row.current && "font-medium")}>
              {row.label}
            </span>
            {row.description && (
              <span className="truncate text-[11px] leading-4 text-muted-foreground">
                {row.description}
              </span>
            )}
          </span>
          {row.secondary && (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {row.secondary}
            </span>
          )}
          {row.meta && (
            <span
              className={cn(
                "ms-auto flex shrink-0 items-center gap-1.5 ps-1 text-xs tabular-nums text-muted-foreground",
                (inline.length > 0 || menu.length > 0) &&
                  "group-hover/row:hidden group-has-[:focus-visible]/row:hidden",
                menuOpen && "hidden",
              )}
            >
              {row.meta}
            </span>
          )}
        </button>
      )}

      {inline.length > 0 && !renaming && (
        <div
          className={cn(
            "hidden shrink-0 items-center group-hover/row:flex group-has-[:focus-visible]/row:flex",
            menuOpen && "flex",
          )}
        >
          {inline.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.label}
                type="button"
                tabIndex={-1}
                aria-label={action.label}
                title={action.label}
                onClick={action.onSelect}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background/70 hover:text-foreground",
                  action.wide && "@max-[15.5rem]/tree:hidden",
                )}
              >
                {Icon && <Icon className="h-3.5 w-3.5" />}
              </button>
            );
          })}
        </div>
      )}

      {menu.length > 0 && !renaming && (
        <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Actions for ${row.label}`}
              title="More actions"
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-background/70 hover:text-foreground",
                "group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100",
                menuOpen && "opacity-100",
              )}
            >
              <Ellipsis className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            // Portalled out of the sidebar, so it does not inherit the face.
            className="min-w-48 font-chrome text-[13px]"
            // Back to the row, not the hidden trigger. While renaming there is
            // no row button, so focus stays in the name field.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              mainRef.current?.focus({ preventScroll: true });
            }}
          >
            {menu.map((action) => (
              <TreeMenuItem key={action.label} action={action} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {row.drop && <DropFeedback drop={row.drop} />}
      {peek.enabled && (
        <PanePeek
          peek={peek.peek}
          scope={preview!}
          onClose={peek.close}
          onPointerEnter={peek.keepOpen}
          onPointerLeave={peek.scheduleClose}
          returnFocus={() => mainRef.current?.focus({ preventScroll: true })}
        />
      )}
    </div>
  );
}

/**
 * Drop target look of a row. Decoration only: the drag chip says what the
 * drop does, and every drop has a menu item for keyboard and screen reader
 * users. Halves are physical, like the pointer test that picks them.
 */
function DropFeedback({ drop }: { drop: RowDrop }) {
  const lit =
    "bg-primary/15 outline outline-1 -outline-offset-1 outline-primary forced-colors:outline-[Highlight]";
  if (drop.kind === "break") {
    return <span aria-hidden className={cn("pointer-events-none absolute inset-0 rounded-md", lit)} />;
  }
  return (
    <span aria-hidden dir="ltr" className="pointer-events-none absolute inset-0 flex gap-px">
      {(["h", "v"] as const).map((direction) => (
        <span
          key={direction}
          className={cn(
            "flex-1 rounded-md",
            direction === drop.direction
              ? lit
              : "outline outline-1 -outline-offset-1 outline-dashed outline-line-strong",
          )}
        />
      ))}
    </span>
  );
}

/** One entry of a row menu. The pane grid draws the same menu. */
export function TreeMenuItem({ action }: { action: TreeAction }) {
  const Icon = action.icon;
  const content = (
    <>
      {Icon ? (
        <Icon className="me-2 h-3.5 w-3.5" />
      ) : (
        <span className="me-2 w-3.5" />
      )}
      {action.label}
      {action.shortcut && (
        <DropdownMenuShortcut className="ps-4 font-mono tracking-normal text-muted-foreground opacity-100">
          {action.shortcut}
        </DropdownMenuShortcut>
      )}
    </>
  );
  return (
    <>
      {action.separated && <DropdownMenuSeparator />}
      {action.submenu ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{content}</DropdownMenuSubTrigger>
          {/* Portalled like the menu, so it takes the same face. */}
          <DropdownMenuSubContent className="min-w-40 font-chrome text-[13px]">
            {action.submenu.map((item) => (
              <TreeMenuItem key={item.label} action={item} />
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : (
        <DropdownMenuItem
          onSelect={action.onSelect}
          className={cn(
            action.destructive && "text-destructive focus:text-destructive",
          )}
        >
          {content}
        </DropdownMenuItem>
      )}
    </>
  );
}

function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  /** Called once with the new value, or with null when cancelled. */
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };
  return (
    <input
      ref={ref}
      aria-label="New name"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(value)}
      className="h-6 min-w-0 flex-1 rounded border border-input bg-background px-1.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}
