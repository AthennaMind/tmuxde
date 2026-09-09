import { getTranslations } from "next-intl/server";

import { Eyebrow } from "@/components/primitives/section";
import { siteConfig } from "@/config/site";

export async function PricingHero() {
  const t = await getTranslations("pricing.hero");

  return (
    <header className="container-content pt-(--spacing-section) pb-8 text-center sm:pb-10">
      <Eyebrow>{t("eyebrow")}</Eyebrow>
      <h1 className="mx-auto max-w-[22ch] text-[clamp(1.75rem,3.9vw,2.9375rem)] leading-[1]">
        {t("title")}
      </h1>
      <p className="mx-auto mt-4 max-w-[54ch] text-[1.1875rem] leading-[1.72] text-text-muted">
        {t("lead")}
      </p>
      {/* Naming the file that enforces the limits is cheap and checkable. */}
      <p className="mx-auto mt-4 max-w-[56ch] text-[0.9375rem] leading-[1.7] text-text-faint">
        {t.rich("note", {
          planLink: (chunks) => (
            <a
              href={`${siteConfig.repo}/blob/main/packages/config/src/plans.ts`}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-text-subtle underline decoration-line-strong underline-offset-2 hover:text-brand hover:decoration-brand"
            >
              {chunks}
            </a>
          ),
        })}
      </p>
    </header>
  );
}
