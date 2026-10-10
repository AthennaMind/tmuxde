"use client";

import { useState } from "react";
import {
  Search,
  FolderOpen,
  Maximize2,
  Minimize2,
  Settings,
  ZoomIn,
  ZoomOut,
  RotateCcw,
} from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import {
  useTerminalStore,
  getDefaultFontSize,
  clampFontSize,
} from "@/stores/terminal-store";
import { TerminalSearch } from "./terminal-search";
import { cn } from "@repo/ui/lib/utils";

interface TerminalToolbarProps {
  onSearch?: (term: string) => void;
  onSearchNext?: () => void;
  onSearchPrevious?: () => void;
  onToggleFullscreen?: () => void;
  onOpenSettings?: () => void;
  onOpenFiles?: () => void;
  isFullscreen?: boolean;
  className?: string;
}

export function TerminalToolbar({
  onSearch,
  onSearchNext,
  onSearchPrevious,
  onToggleFullscreen,
  onOpenSettings,
  onOpenFiles,
  isFullscreen = false,
  className,
}: TerminalToolbarProps) {
  const [showSearch, setShowSearch] = useState(false);
  // Selected per field. `useTerminalStore()` re-renders this toolbar — and the
  // search box inside it — on every write to the store, and a pinch writes
  // `fontSize` about twenty times a second.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const fontSize = useTerminalStore((s) => s.fontSize);
  const setFontSize = useTerminalStore((s) => s.setFontSize);

  return (
    <div className={cn("flex items-center gap-2 px-3 py-1.5", className)}>
      <span className="text-sm font-medium truncate">
        {activeSessionId ?? "No session"}
      </span>

      <div className="flex-1" />

      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setFontSize(clampFontSize(fontSize - 1))}
          aria-label="Decrease font size"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs text-muted-foreground w-8 text-center tabular-nums">
          {fontSize}px
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setFontSize(clampFontSize(fontSize + 1))}
          aria-label="Increase font size"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setFontSize(getDefaultFontSize())}
          title="Reset zoom (Ctrl+0)"
          aria-label="Reset font size"
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      </div>

      {showSearch && (
        <TerminalSearch
          onSearch={onSearch ?? (() => {})}
          onNext={onSearchNext}
          onPrevious={onSearchPrevious}
          onClose={() => setShowSearch(false)}
        />
      )}

      {onOpenFiles && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenFiles}
          aria-label="Open files"
        >
          <FolderOpen className="mr-1 h-4 w-4" />
          Files
        </Button>
      )}

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setShowSearch(!showSearch)}
        aria-label="Toggle search"
      >
        <Search className="h-3.5 w-3.5" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onToggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      >
        {isFullscreen ? (
          <Minimize2 className="h-3.5 w-3.5" />
        ) : (
          <Maximize2 className="h-3.5 w-3.5" />
        )}
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onOpenSettings}
        aria-label="Open settings"
      >
        <Settings className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
