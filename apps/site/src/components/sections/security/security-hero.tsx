import { getTranslations } from "next-intl/server";

import { Eyebrow } from "@/components/primitives/section";
import { siteConfig } from "@/config/site";

export async function SecurityHero() {
  const t = await getTranslations("security.hero");

  return (
    <header className="container-content pt-(--spacing-section) pb-8 sm:pb-10">
      <Eyebrow>{t("eyebrow")}</Eyebrow>
      <h1 className="max-w-[20ch] text-[clamp(1.75rem,3.9vw,2.9375rem)] leading-[1]">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-[58ch] text-[1.1875rem] leading-[1.72] text-text-muted">
        {t("lead")}
      </p>
      {/* Points at the actual implementation. A security page that cannot be
          checked against source is a marketing page wearing a lab coat. */}
      <p className="mt-4 max-w-[58ch] text-[1rem] leading-[1.72] text-text-subtle">
        {t.rich("note", {
          repoLink: (chunks) => (
            <a
              href={`${siteConfig.repo}/tree/main/packages/crypto`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
            >
              {chunks}
            </a>
          ),
        })}
      </p>
    </header>
  );
}
