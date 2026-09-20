"use client";

import { Terminal, LayoutList, FolderOpen, Settings } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { filesDisabled, useConnectionStore } from "@/stores/connection-store";

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

export function MobileNav({
  activeTab,
  onTabChange,
  className,
}: MobileNavProps) {
  const capabilities = useConnectionStore((s) => s.capabilities);
  // A share with no file access gets no Files tab at all. Leaving it in place
  // would open a browser whose every request comes back ACCESS_DENIED, which
  // reads as a broken app rather than as the share it is.
  const visible = filesDisabled(capabilities)
    ? tabs.filter((t) => t.id !== "files")
    : tabs;

  // No safe-area padding here — AppShell already insets the whole frame, and
  // doubling it stole ~34px of screen on notched devices.
  return (
    <nav
      className={cn(
        "flex items-center justify-around border-t landscape:py-0.5",
        className,
      )}
    >
      {visible.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={cn(
            "flex min-h-11 flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[11px] transition-colors landscape:flex-row landscape:gap-1.5 landscape:py-1 landscape:text-[11px]",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            activeTab === id
              ? "text-primary"
              : "text-muted-foreground active:text-foreground",
          )}
          onClick={() => onTabChange(id)}
        >
          <Icon className="h-5 w-5 landscape:h-4 landscape:w-4" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
