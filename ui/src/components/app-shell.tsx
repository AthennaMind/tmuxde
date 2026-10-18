import * as React from "react";
import { cn } from "../lib/utils";

interface AppShellProps {
  header?: React.ReactNode;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * The frame: header, scrolling body, footer, inside the safe area.
 *
 * The height is `--vv-height` — the *visual* viewport — with `100dvh` as the
 * fallback for anything that has not published one yet (`VisualViewportSync`
 * sets it on `:root`). That distinction is the whole reason this comment
 * exists. `interactiveWidget: "resizes-content"` shrinks the layout viewport
 * when the soft keyboard opens, so `100dvh` alone is correct on Chromium and
 * wrong on iOS Safari, which does not implement it: there the box stayed full
 * height and the entire footer — command bar, keyboard toolbar and all — sat
 * underneath the keyboard. The one row that exists *because* the keyboard is
 * up was the one row you could not reach.
 *
 * `CommandComposer` already sized itself this way for the same reason; this is
 * that fix applied where the footer actually lives. On Chromium the two agree,
 * because `--vv-height` and the shrunk `100dvh` are the same number.
 */
export function AppShell({ header, toolbar, children, className }: AppShellProps) {
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden",
        "pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]",
        "pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]",
        className,
      )}
      style={{
        height: "var(--vv-height, 100dvh)",
        touchAction: "manipulation",
      }}
    >
      {header && (
        // `empty:hidden`: banners render nothing when healthy, and an empty
        // header would still draw its border.
        <header className="shrink-0 border-b bg-background/95 empty:hidden backdrop-blur supports-[backdrop-filter]:bg-background/60">
          {header}
        </header>
      )}
      <main className="relative min-h-0 flex-1 overflow-hidden">{children}</main>
      {toolbar && (
        <footer className="shrink-0 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          {toolbar}
        </footer>
      )}
    </div>
  );
}
