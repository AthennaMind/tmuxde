import { Terminal, LayoutList, FolderOpen, Settings } from "lucide-react";
import { cn } from "@/shared/utils";
import { filesDisabled, useConnectionStore } from "@/features/connection/connection-store";

export type MobileTab = "terminal" | "sessions" | "files" | "settings";

interface MobileNavProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  className?: string;
}

const tabs: { id: MobileTab; label: string; icon: typeof Terminal }[] = [
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "sessions", label: "Sessions", icon: LayoutList },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "settings", label: "Settings", icon: Settings },
];

export function MobileNav({ activeTab, onTabChange, className }: MobileNavProps) {
  const capabilities = useConnectionStore((s) => s.capabilities);
  // A share with no file access gets no Files tab at all. Leaving it in place
  // would open a browser whose every request comes back ACCESS_DENIED, which
  // reads as a broken app rather than as the share it is.
  const visible = filesDisabled(capabilities) ? tabs.filter((t) => t.id !== "files") : tabs;

  // AppShell owns safe-area padding. Keep this dock inside its footer.
  return (
    <nav
      aria-label="Workspace"
      className={cn("px-3 py-1.5 font-sans landscape:px-2 landscape:py-1", className)}
    >
      <div className="mx-auto flex max-w-lg items-stretch gap-1 rounded-2xl bg-surface-panel p-1 shadow-ambient ring-1 ring-inset ring-line-subtle">
        {visible.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[calc(var(--radius-2xl)-0.25rem)] px-1 py-1 text-xs leading-4 landscape:min-h-11 landscape:flex-row landscape:gap-2",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                "motion-safe:transition-[background-color,color] motion-safe:duration-150",
                active
                  ? "bg-brand-subtle font-semibold text-primary"
                  : "font-medium text-muted-foreground hover:bg-surface-hover hover:text-foreground active:bg-surface-hover",
              )}
              onClick={() => onTabChange(id)}
            >
              <Icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={active ? 2 : 1.5} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
