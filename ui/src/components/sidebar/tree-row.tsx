import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Ellipsis } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/ui/components/ui/dropdown-menu";
import { cn } from "@repo/ui/lib/utils";

type Icon = React.ComponentType<{ className?: string }>;

export interface TreeAction {
  label: string;
  icon?: Icon;
  onSelect: () => void;
  destructive?: boolean;
  /** Draw a separator above this item. */
  separated?: boolean;
  submenu?: { label: string; onSelect: () => void }[];
}

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
}

/** Arrow keys, Home and End move focus between rows of one tree. */
export function useTreeKeyboard() {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
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

  const handleKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
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
        "group/row relative flex h-7 items-center gap-0.5 rounded-md pe-0.5 text-[13px]",
        "has-[[data-tree-row]:focus-visible]:ring-1 has-[[data-tree-row]:focus-visible]:ring-ring",
        row.selected
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-accent/50",
        row.muted && !row.selected && "text-muted-foreground",
        row.pending && "opacity-70",
      )}
      style={{ paddingInlineStart: indent }}
      onContextMenu={(event) => {
        if (!menu.length) return;
        event.preventDefault();
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
          title={row.title ?? row.label}
          onFocus={() => onFocusRow(row.key)}
          onClick={row.activate}
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
          <span
            className={cn("min-w-0 shrink truncate", row.current && "font-medium")}
          >
            {row.label}
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
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background/70 hover:text-foreground"
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
              <MenuItem key={action.label} action={action} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function MenuItem({ action }: { action: TreeAction }) {
  const Icon = action.icon;
  const content = (
    <>
      {Icon ? (
        <Icon className="me-2 h-3.5 w-3.5" />
      ) : (
        <span className="me-2 w-3.5" />
      )}
      {action.label}
    </>
  );
  return (
    <>
      {action.separated && <DropdownMenuSeparator />}
      {action.submenu ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{content}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {action.submenu.map((item) => (
              <DropdownMenuItem key={item.label} onSelect={item.onSelect}>
                {item.label}
              </DropdownMenuItem>
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
