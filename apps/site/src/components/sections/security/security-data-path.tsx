import { getTranslations } from "next-intl/server";

import { cn } from "@/lib/utils";

type Stage = { title: string; description: string };

export async function SecurityDataPath() {
  const t = await getTranslations("security.dataPath");
  const stages = t.raw("stages") as Stage[];

  return (
    <section
      id="data-path"
      className="container-content pb-(--spacing-section)"
    >
      <div className="rounded-xl border border-line bg-surface-panel p-5 sm:p-8">
        <p className="eyebrow mb-5 text-text-faint">{t("label")}</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stages.map((stage, index) => {
            const isRelay = index === 2;
            return (
              <div
                key={stage.title}
                className={cn(
                  "rounded-lg border bg-surface-raised p-4",
                  isRelay
                    ? "border-dashed border-signal-blocked"
                    : "border-line-strong",
                )}
              >
                <p
                  className={cn(
                    "mb-2 text-[1rem]",
                    isRelay ? "text-signal-blocked" : "text-text-strong",
                  )}
                >
                  {stage.title}
                </p>
                <p className="text-[0.875rem] leading-[1.65] text-text-muted">
                  {stage.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
