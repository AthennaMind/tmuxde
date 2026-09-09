"use client";

import { useState, useCallback } from "react";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";
import { Input } from "@repo/ui/components/ui/input";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";

/**
 * 44px on a touch screen, compact on a pointer device.
 *
 * These were 24px squares floating over a live pty, which is the worst place
 * in the app to miss: a tap that slips off "next match" lands on the terminal
 * instead. The window-tabs idea applies — the target is the full 44px while
 * the glyph inside stays small — so the bar only grows where it has to.
 */
const iconButtonClass = "h-11 w-11 md:h-7 md:w-7";

interface TerminalSearchProps {
  onSearch: (term: string) => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onClose: () => void;
  className?: string;
}

export function TerminalSearch({
  onSearch,
  onNext,
  onPrevious,
  onClose,
  className,
}: TerminalSearchProps) {
  const [query, setQuery] = useState("");

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
      onSearch(e.target.value);
    },
    [onSearch],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter") {
        if (e.shiftKey) {
          onPrevious?.();
        } else {
          onNext?.();
        }
      }
    },
    [onClose, onNext, onPrevious],
  );

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md border bg-background px-2 py-1 shadow-sm",
        className,
      )}
    >
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <Input
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Search..."
        aria-label="Search terminal output"
        // `text-[16px]`, not `text-sm`. Below 16px iOS zooms the whole page on
        // focus, and this bar floats over the terminal — so the zoom lands on
        // the output you were trying to search. Same reasoning, same value as
        // the command bar; see mobile-command-bar.tsx. `md:text-sm` from the
        // base survives, so a pointer device still gets the compact size.
        className="border-0 bg-transparent px-1 text-[16px] focus-visible:ring-0"
        autoFocus
      />
      <Button
        variant="ghost"
        size="icon"
        className={iconButtonClass}
        aria-label="Previous match"
        onClick={onPrevious}
      >
        <ChevronUp className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={iconButtonClass}
        aria-label="Next match"
        onClick={onNext}
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={iconButtonClass}
        aria-label="Close search"
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
