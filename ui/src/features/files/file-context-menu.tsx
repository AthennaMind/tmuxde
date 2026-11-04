import { useRef, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { TreeAction } from "@/features/workspace/tree-row";

export function FileContextMenu({
  actions,
  children,
}: {
  actions: TreeAction[];
  children: ReactNode;
}) {
  const trigger = useRef<HTMLDivElement>(null);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={trigger}
          className="flex min-h-0 flex-1 flex-col"
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              !(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const target = event.target as HTMLElement;
            const rect = target.getBoundingClientRect();
            target.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                button: 2,
                clientX: rect.left + 16,
                clientY: rect.bottom,
              }),
            );
          }}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-52 font-chrome text-[13px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
            const target =
              document.querySelector<HTMLElement>("[data-file-name-input]") ??
              trigger.current?.querySelector<HTMLElement>("[data-tree-row], [data-file-tree-root]");
            target?.focus({ preventScroll: true });
          });
        }}
      >
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <div key={action.label}>
              {action.separated && <ContextMenuSeparator />}
              <ContextMenuItem
                onSelect={action.onSelect}
                className={
                  action.destructive ? "text-destructive focus:text-destructive" : undefined
                }
              >
                {Icon && <Icon aria-hidden className="h-4 w-4" />}
                <span className="flex-1">{action.label}</span>
                {action.shortcut && (
                  <span className="ps-4 text-xs text-muted-foreground">{action.shortcut}</span>
                )}
              </ContextMenuItem>
            </div>
          );
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
}
