import { getTranslations } from "next-intl/server";

import { Eyebrow } from "@/components/primitives/section";

/** Page header: eyebrow, h1 and lead paragraph. Mirrors the agents/features hero. */
export async function CompareHero() {
  const t = await getTranslations("compare.hero");

  return (
    <header className="container-content pt-(--spacing-section) pb-12 sm:pb-16">
      <Eyebrow>{t("eyebrow")}</Eyebrow>
      <h1 className="max-w-[22ch] text-[clamp(1.6875rem,3.9vw,2.9375rem)] leading-[1]">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-[58ch] text-[1.1875rem] leading-[1.72] text-text-muted">
        {t("lead")}
      </p>
    </header>
  );
}
