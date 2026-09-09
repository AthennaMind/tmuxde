import { getTranslations } from "next-intl/server";

import { Eyebrow } from "@/components/primitives/section";

export async function ChangelogHero() {
  const t = await getTranslations("changelog.hero");

  return (
    <header className="container-content pt-(--spacing-section) pb-8 sm:pb-10">
      <Eyebrow>{t("eyebrow")}</Eyebrow>
      <h1 className="max-w-[20ch] text-[clamp(1.75rem,3.8vw,2.8125rem)] leading-[1]">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-[52ch] text-[1.125rem] leading-[1.72] text-text-muted">
        {t("lead")}
      </p>
    </header>
  );
}
