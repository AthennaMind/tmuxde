import { useRef, useState, type ReactElement } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export interface ChangeMenuAction {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onSelect: () => void;
  disabled?: boolean;
  separated?: boolean;
  destructive?: boolean;
}

export function ChangeContextMenu({
  actions,
  children,
}: {
  actions: ChangeMenuAction[];
  children: ReactElement;
}) {
  const trigger = useRef<HTMLSpanElement>(null);
  const [snapshot, setSnapshot] = useState<ChangeMenuAction[] | null>(null);
  return (
    <ContextMenu onOpenChange={(open) => setSnapshot(open ? actions : null)}>
      <ContextMenuTrigger
        asChild
        ref={trigger}
        onContextMenu={(event) => {
          document
            .querySelectorAll("[data-change-menu-origin]")
            .forEach((element) => element.removeAttribute("data-change-menu-origin"));
          event.currentTarget.setAttribute("data-change-menu-origin", "");
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(
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
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-52 font-chrome text-[13px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            if (!document.querySelector('[role="alertdialog"]'))
              trigger.current?.focus({ preventScroll: true });
          });
        }}
      >
        {(snapshot ?? actions).map(({ icon: Icon, ...action }) => (
          <div key={action.label}>
            {action.separated && <ContextMenuSeparator />}
            <ContextMenuItem
              disabled={action.disabled}
              onSelect={action.onSelect}
              className={
                action.destructive
                  ? "pointer-coarse:min-h-11 text-destructive focus:text-destructive"
                  : "pointer-coarse:min-h-11"
              }
            >
              <Icon className="h-4 w-4" aria-hidden />
              {action.label}
            </ContextMenuItem>
          </div>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
