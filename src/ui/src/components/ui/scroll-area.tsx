import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "../../lib/utils";
import { MiniScrollbar } from "./mini-scrollbar";

/**
 * `type="auto"` — a scrollbar whenever there is something to scroll.
 *
 * Radix defaults to `"hover"`, which on a touchscreen means *never*: there is
 * no hover, so every scrolling panel in the app — settings, files, sessions,
 * the machine sheet — was a surface with no indication that it scrolled, no
 * sense of how much was below the fold, and nothing to drag. Overriding the
 * default here rather than at each call site is deliberate; the alternative is
 * one panel someone forgets.
 */
const ScrollArea = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    /** Which axis gets an overlay bar. Defaults to vertical. */
    scrollbars?: "vertical" | "horizontal" | "both";
  }
>(
  (
    { className, children, type = "auto", scrollbars = "vertical", ...props },
    ref,
  ) => {
    /*
     * The viewport node, for the overlay bar below.
     *
     * Radix draws its own scrollbar, but only where its measurement says the
     * content overflows — and on a touch layout that measurement is frequently
     * "no bar", so panels that plainly scrolled showed nothing at all. The
     * overlay reads `scrollTop`/`scrollHeight` off the viewport itself, which is
     * the same number the browser scrolls by, so it cannot disagree with what
     * the user is looking at.
     */
    const [viewport, setViewport] = React.useState<HTMLDivElement | null>(null);

    return (
      <ScrollAreaPrimitive.Root
        ref={ref}
        type={type}
        className={cn("relative overflow-hidden", className)}
        {...props}
      >
        <ScrollAreaPrimitive.Viewport
          ref={setViewport}
          className="h-full w-full rounded-[inherit]"
        >
          {children}
        </ScrollAreaPrimitive.Viewport>
        {scrollbars !== "horizontal" && <MiniScrollbar target={viewport} />}
        {scrollbars !== "vertical" && (
          <MiniScrollbar target={viewport} orientation="horizontal" />
        )}
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    );
  },
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-colors",
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className,
    )}
    {...props}
  >
    {/* `bg-border` was near-invisible against a panel; this is the same thumb
        the themed native scrollbars use (see globals.css). */}
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-muted-foreground/40 transition-colors hover:bg-muted-foreground/60" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
