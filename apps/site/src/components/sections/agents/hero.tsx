import { getTranslations } from "next-intl/server";

import { Eyebrow } from "@/components/primitives/section";
import { inlineLink } from "@/lib/rich-links";

/** Page header: eyebrow, h1 and lead paragraph. Mirrors the features hero. */
export async function AgentsHero() {
  const t = await getTranslations("agents.hero");

  return (
    <header className="container-content pt-(--spacing-section) pb-12 sm:pb-16">
      <Eyebrow tone="agent">{t("eyebrow")}</Eyebrow>
      <h1 className="max-w-[22ch] text-[clamp(1.75rem,4.2vw,3.125rem)] leading-[0.98]">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-[58ch] text-[1.1875rem] leading-[1.72] text-text-muted">
        {t("lead")}
      </p>
      {/* The "does it ping me?" answer, above the fold, because it is the first
          thing every visitor to this page wants to know. */}
      <p className="mt-5 max-w-[58ch] border-s-2 border-line-strong ps-4 text-[1rem] leading-[1.7] text-text-subtle">
        {t.rich("note", {
          post: inlineLink("/blog/coding-agent-notifications"),
        })}
      </p>
    </header>
  );
}
