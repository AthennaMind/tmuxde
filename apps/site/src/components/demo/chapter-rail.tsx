"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface Chapter {
  id: string;
  title: string;
  description: ReactNode;
}

/**
 * The chapter list, and the demo's only navigation.
 *
 * These are real buttons rather than a decorative legend: with reduced motion
 * the transport is disabled, and this rail is then the *only* way to see the
 * other four frames. It has to stay usable in that mode.
 *
 * `HairlineGrid` renders `div`s, so the hairline look is reproduced on the
 * buttons directly rather than by teaching the primitive an `as` prop.
 */
export function ChapterRail({
  chapters,
  active,
  onSelect,
  className,
}: {
  chapters: Chapter[];
  active: number;
  onSelect: (index: number) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-5",
        className,
      )}
    >
      {chapters.map((chapter, i) => {
        const isActive = i === active;
        return (
          <button
            key={chapter.id}
            type="button"
            onClick={() => onSelect(i)}
            aria-current={isActive ? "step" : undefined}
            className={cn(
              "group flex flex-col bg-surface-raised p-5 text-start transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
              isActive ? "bg-surface-panel" : "hover:bg-surface-panel",
            )}
          >
            <span
              className={cn(
                "font-mono text-[0.875rem]",
                isActive ? "text-brand" : "text-text-faint",
              )}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            {/* `role="heading"` rather than a real `<h3>`: these titles live
                inside a `<button>`, whose content model is phrasing content,
                so an element-level heading here would be invalid HTML. The
                crawler-facing value of the five chapters is carried by the
                `HowTo` node on `page.tsx`; this is the assistive-tech half. */}
            <span
              role="heading"
              aria-level={3}
              className={cn(
                "mt-4 font-sans text-[1rem] font-600 tracking-[-0.01em]",
                isActive ? "text-text-strong" : "text-text",
              )}
            >
              {chapter.title}
            </span>
            <span className="mt-2 text-[0.875rem] leading-[1.65] text-text-muted">
              {chapter.description}
            </span>
            {/* Underline the live chapter. A colour change alone would be the
                only signal, and colour alone is not a signal. */}
            <span
              aria-hidden="true"
              className={cn(
                "mt-4 h-px w-full origin-left transition-transform duration-300",
                isActive ? "scale-x-100 bg-brand" : "scale-x-0 bg-line",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
