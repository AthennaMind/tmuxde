"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { cn } from "@repo/ui/lib/utils";
import { useSessionStore } from "@/stores/session-store";
import { LAST_SESSION_KEY, writeStored } from "@/lib/storage-keys";

interface SessionTabsProps {
  onCreateClick: () => void;
  className?: string;
}

export function SessionTabs({ onCreateClick, className }: SessionTabsProps) {
  const openedSessions = useSessionStore((s) => s.openedSessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const closeSession = useSessionStore((s) => s.closeSession);

  return (
    <div className={cn("flex items-center", className)}>
      <ScrollArea className="flex-1" scrollbars="horizontal">
        <div role="tablist" className="flex items-center gap-1 px-1">
          {openedSessions.map((name) => {
            // A div, not a button: the close control below is a real button
            // and `<button>` inside `<button>` is invalid HTML. The parser
            // hoists the inner one out of the outer, so the served markup
            // never matches what React rendered and hydration fails.
            return (
              <div
                key={name}
                role="tab"
                tabIndex={0}
                aria-selected={name === activeSessionId}
                title={name}
                className={cn(
                  "group flex cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-3.5 py-1.5 text-sm transition-colors animate-in fade-in slide-in-from-bottom-1 duration-200",
                  name === activeSessionId
                    ? "border-primary bg-primary/10 text-foreground font-semibold"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
                onClick={() => {
                  setActiveSession(name);
                  writeStored(LAST_SESSION_KEY, name);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  setActiveSession(name);
                  writeStored(LAST_SESSION_KEY, name);
                }}
              >
                <span className="truncate max-w-[120px]">{name}</span>
                <button
                  aria-label={`Close ${name}`}
                  className="hidden group-hover:inline-flex h-5 w-5 items-center justify-center rounded-sm hover:bg-destructive/20"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(name);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={onCreateClick}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
