import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { Cmd } from "@/components/primitives/cards";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

type EntryType = "new" | "perf" | "fix" | "break";

type ReleaseEntry = {
  type: EntryType;
  text: string;
};

type Release = {
  id: string;
  version: string;
  /**
   * Deliberately a free-text label, not an ISO date.
   *
   * This project does not have reliable release dates for its early versions,
   * and inventing them to fill a column is exactly the kind of small lie that
   * makes the rest of a changelog worthless. "current release on npm" is both
   * true and more useful than a fabricated day.
   */
  date: string;
  current?: boolean;
  unreleased?: boolean;
  firstRelease?: boolean;
  entries: ReleaseEntry[];
};

/** Maps each changelog entry type to the site's shared semantic tokens. */
const TYPE_TOKEN: Record<EntryType, string> = {
  new: "text-signal-done",
  perf: "text-signal-stalled",
  fix: "text-signal-blocked",
  break: "text-signal-agent",
};

const cmdHandler = {
  cmd: (chunks: ReactNode) => <Cmd>{chunks}</Cmd>,
};

export async function ChangelogTimeline() {
  const t = await getTranslations("changelog");
  const releases = t.raw("releases") as Release[];
  const typeLabels = t.raw("typeLabels") as Record<EntryType, string>;

  return (
    <section className="border-t border-line-subtle">
      <div className="container-content grid gap-9 py-(--spacing-section) sm:gap-11">
        {releases.map((release, releaseIndex) => (
          <article
            key={release.id}
            id={release.id}
            className="grid scroll-mt-24 gap-3.5 border-b border-line-subtle pb-9 last:border-b-0 last:pb-0 sm:gap-4 sm:pb-11"
          >
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={`#${release.id}`}
                className={cn(
                  "rounded-md px-2.5 py-1 font-mono text-[0.875rem] font-700 no-underline",
                  release.current
                    ? "bg-brand text-brand-contrast"
                    : "border border-line-strong bg-surface-panel text-text",
                )}
              >
                {release.version}
              </a>
              <span className="font-mono text-[0.875rem] text-text-faint">
                {release.date}
                {release.current ? ` · ${t("current")}` : null}
                {release.unreleased ? ` · ${t("unreleased")}` : null}
                {release.firstRelease ? ` · ${t("firstRelease")}` : null}
              </span>
            </div>

            <div className="grid gap-2.5 text-[1rem] leading-[1.75] text-text-muted">
              {release.entries.map((entry, index) => (
                <div key={index} className="flex gap-3">
                  <span
                    className={cn(
                      "shrink-0 basis-11 font-mono text-[0.875rem]",
                      TYPE_TOKEN[entry.type],
                    )}
                  >
                    {typeLabels[entry.type]}
                  </span>
                  <span>
                    {t.rich(
                      `releases.${releaseIndex}.entries.${index}.text`,
                      cmdHandler,
                    )}
                  </span>
                </div>
              ))}
            </div>
          </article>
        ))}

        <div className="rounded-xl border border-line bg-surface-raised p-5 text-[1rem] leading-[1.75] text-text-muted">
          {t.rich("subscribe", {
            ...cmdHandler,
            ghLink: (chunks) => (
              <a
                href={siteConfig.social.releases}
                target="_blank"
                rel="noreferrer noopener"
                className="text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
              >
                {chunks}
              </a>
            ),
          })}
        </div>
      </div>
    </section>
  );
}
