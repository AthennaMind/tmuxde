"use client";

import {
  Search,
  FolderOpen,
  Settings,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";
import { useSessionStore } from "@/stores/session-store";
import { useUiStore } from "@/stores/ui-store";
import {
  useTerminalStore,
  getDefaultFontSize,
  clampFontSize,
} from "@/stores/terminal-store";
import { WindowTabs } from "@/components/mobile/window-tabs";
import { AlertBanner } from "@/components/alert-banner";
import { PhotoUpload } from "@/components/terminal/photo-upload";
import { RecentPhotos } from "@/components/terminal/recent-photos";

/** Photo controls carry their own border for the mobile key row. Here they sit with ghost buttons. */
const ghostPhotoClass =
  "h-8 min-h-0 border-transparent bg-transparent hover:bg-accent hover:text-accent-foreground @max-5xl:px-2";

/**
 * The bar gives way in steps as the terminal column narrows, so window tabs
 * keep their room. Below 64rem, text labels go. They stay as screen reader
 * text, and each button keeps a tooltip. Below 48rem, font size goes.
 * Settings still reaches it. Past that, actions wrap to a second row.
 */
const labelClass = "@max-5xl:sr-only";
const groupGap = "gap-x-4 @max-3xl:gap-x-2";

interface TerminalToolbarProps {
  onOpenSettings?: () => void;
  onOpenFiles?: () => void;
  filesOpen?: boolean;
  /** The sidebar names the session. Collapsed, nothing else does. */
  showSessionName?: boolean;
  className?: string;
}

/**
 * The only bar above the desktop terminal.
 *
 * Windows lead because they change most often. Actions trail in three groups:
 * input, browse, view. Space separates the groups, so no dividers.
 */
export function TerminalToolbar({
  onOpenSettings,
  onOpenFiles,
  filesOpen = false,
  showSessionName = false,
  className,
}: TerminalToolbarProps) {
  // Selected per field. A pinch writes `fontSize` about twenty times a second.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const fontSize = useTerminalStore((s) => s.fontSize);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const searchOpen = useUiStore((s) => s.terminalSearchOpen);
  const setSearchOpen = useUiStore((s) => s.setTerminalSearchOpen);

  return (
    <div className={cn("@container shrink-0 border-b", className)}>
      <div className={cn("flex min-h-11 flex-wrap items-center px-2", groupGap)}>
        {showSessionName && activeSessionId && (
          <span
            className="max-w-40 shrink-0 truncate ps-1 text-sm font-medium"
            title={activeSessionId}
          >
            {activeSessionId}
          </span>
        )}

        <WindowTabs className="min-w-0 flex-initial border-b-0 px-0" />

        <div
          className={cn("ms-auto flex shrink-0 items-center", groupGap)}
        >
          <AlertBanner />

          <div className="flex items-center gap-1">
            <PhotoUpload
              className={ghostPhotoClass}
              labelClassName={labelClass}
            />
            <RecentPhotos
              className={ghostPhotoClass}
              labelClassName={labelClass}
            />
          </div>

          <div className="flex items-center gap-1">
            {onOpenFiles && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenFiles}
                aria-pressed={filesOpen}
                className={cn(
                "@max-5xl:px-2",
                filesOpen && "bg-accent text-accent-foreground",
              )}
                title="Repository files"
              >
                <FolderOpen aria-hidden />
                <span className={labelClass}>Files</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", searchOpen && "bg-accent")}
              onClick={() => setSearchOpen(!searchOpen)}
              aria-label="Search terminal"
              aria-pressed={searchOpen}
              title="Search terminal"
            >
              <Search aria-hidden />
            </Button>
          </div>

          <div className="flex items-center gap-1">
            <div
              role="group"
              aria-label="Font size"
              className="flex items-center @max-3xl:hidden"
            >
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setFontSize(clampFontSize(fontSize - 1))}
                aria-label="Decrease font size"
                title="Decrease font size"
              >
                <ZoomOut aria-hidden />
              </Button>
              {/* Value and reset in one control. Reset to default is the only
                  thing anyone wants to do with the number. */}
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-1.5 tabular-nums text-muted-foreground"
                onClick={() => setFontSize(getDefaultFontSize())}
                aria-label={`Font size ${fontSize}px. Reset to default`}
                title="Reset font size"
              >
                {fontSize}px
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setFontSize(clampFontSize(fontSize + 1))}
                aria-label="Increase font size"
                title="Increase font size"
              >
                <ZoomIn aria-hidden />
              </Button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onOpenSettings}
              aria-label="Open settings"
              title="Settings"
            >
              <Settings aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
