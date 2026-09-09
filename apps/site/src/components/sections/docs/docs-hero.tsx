import { getTranslations } from "next-intl/server";

import { Eyebrow } from "@/components/primitives/section";

import { DocsToc } from "./docs-toc";

export async function DocsHero() {
  const t = await getTranslations("docs.hero");

  return (
    <header className="container-content pt-(--spacing-section) pb-10 sm:pb-12">
      <Eyebrow>{t("eyebrow")}</Eyebrow>
      <h1 className="max-w-[20ch] text-[clamp(1.75rem,3.8vw,2.8125rem)] leading-[1]">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-[56ch] text-[1.125rem] leading-[1.72] text-text-muted">
        {t("lead")}
      </p>
      <DocsToc variant="row" />
    </header>
  );
}
