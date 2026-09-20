"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/ui/components/ui/sheet";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { useSettingsStore } from "@/stores/settings-store";
import { cheatsheetFor } from "@/lib/gesture-cheatsheet";

/**
 * The cheat sheet behind the `?`.
 *
 * Deliberately not a tour, a tooltip or a first-run overlay. Those interrupt
 * someone who has not asked yet and are gone by the time they want them; this
 * is two taps away forever and costs nothing until it is opened. It reads from
 * `cheatsheetFor`, so a gesture switched off in settings is absent rather than
 * listed and broken.
 */
export function GestureHelpSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const gestures = useSettingsStore((s) => s.gestures);
  const sections = cheatsheetFor(gestures);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex h-[70vh] flex-col px-4 pt-4">
        <SheetHeader className="pb-2 text-left">
          <SheetTitle className="text-sm">Gestures</SheetTitle>
          <SheetDescription className="text-xs">
            What this screen does that it does not say out loud.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="-mx-4 h-0 flex-1 px-4">
          <div className="space-y-5 pb-6">
            {sections.map((section) => (
              <section key={section.title}>
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
                  {section.title}
                </h3>
                <ul className="space-y-2">
                  {section.entries.map((entry) => (
                    <li
                      key={entry.gesture}
                      className="flex items-baseline gap-3"
                    >
                      {/*
                        A fixed column for the gesture, so the effects line up
                        into something scannable. It wraps rather than
                        truncating: "Press and hold" losing its last word to an
                        ellipsis would make the one entry most people came here
                        for the one they cannot read.
                      */}
                      <span className="w-28 shrink-0 text-xs font-medium text-foreground">
                        {entry.gesture}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {entry.effect}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            <p className="text-xs text-muted-foreground">
              Every gesture here can be switched off in Settings › Gestures.
            </p>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
