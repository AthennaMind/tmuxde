import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { SectionHeading } from "@/components/primitives/section";
import { cn } from "@/lib/utils";

/**
 * `check` is a moment you chose to open the session; `act` is one where you
 * did something to it. Deliberately only two accents plus neutral: the old
 * done/blocked/stalled/failed palette described notification levels the
 * product does not emit, and re-using it here would imply the same thing in
 * colour that the copy is careful not to say in words.
 */
type TimelineTone = "neutral" | "check" | "act";

type TimelineItem = {
  time: string;
  tone: TimelineTone;
  text: string;
};

const TIME_COLOR: Record<TimelineTone, string> = {
  neutral: "text-text-faint",
  check: "text-text-subtle",
  act: "text-brand",
};

function path(chunks: ReactNode) {
  return <span className="text-text-strong">{chunks}</span>;
}

function accent(chunks: ReactNode) {
  return <span className="text-brand">{chunks}</span>;
}

/** A morning with three agents running, told as a timeline. */
export async function AgentTimeline() {
  const t = await getTranslations("agents.timeline");
  const items = t.raw("items") as TimelineItem[];

  return (
    <section className="border-t border-line-subtle">
      <div className="container-content py-(--spacing-section)">
        <SectionHeading level={2} size="sm" title={t("title")} />
        <ol className="mt-8 grid max-w-3xl gap-3 sm:mt-10">
          {items.map((item, index) => (
            <li
              key={item.time}
              className={cn(
                "grid grid-cols-[4rem_1fr] items-start gap-4",
                index < items.length - 1 && "border-b border-line-subtle pb-3",
              )}
            >
              <span
                className={cn(
                  "pt-0.5 font-mono text-[0.875rem]",
                  TIME_COLOR[item.tone],
                )}
              >
                {item.time}
              </span>
              <p className="text-[1rem] leading-[1.6] text-text">
                {t.rich(`items.${index}.text`, { path, accent })}
              </p>
            </li>
          ))}
        </ol>
        <p className="mt-6 max-w-3xl text-[1rem] text-text-faint">
          {t("note")}
        </p>
      </div>
    </section>
  );
}
