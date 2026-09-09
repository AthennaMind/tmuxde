import { getTranslations } from "next-intl/server";

import { Eyebrow } from "@/components/primitives/section";

export async function FeaturesHero() {
  const t = await getTranslations("features.hero");

  return (
    <header className="container-content pt-(--spacing-section) pb-12 sm:pb-16">
      <Eyebrow>{t("eyebrow")}</Eyebrow>
      <h1 className="max-w-[20ch] text-[clamp(1.75rem,4.2vw,3.125rem)] leading-[0.98]">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-[56ch] text-[1.1875rem] leading-[1.72] text-text-muted">
        {t("lead")}
      </p>
    </header>
  );
}
