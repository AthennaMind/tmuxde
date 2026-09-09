import { getTranslations } from "next-intl/server";

import { Section, SectionHeading } from "@/components/primitives/section";
import { buttonVariants } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

/**
 * What used to be a Team tier.
 *
 * There is no team plan, so this says so rather than listing SSO, SCIM and an
 * audit log that do not exist. A "talk to us" box with no feature promises
 * attached costs nothing to honour and cannot be held against us later.
 */
export async function PricingTeam() {
  const t = await getTranslations("pricing.team");

  return (
    <Section>
      <div className="mx-auto max-w-2xl rounded-xl border border-line bg-surface-raised p-7 text-center sm:p-9">
        <SectionHeading
          title={t("title")}
          level={2}
          size="sm"
          align="center"
          className="mb-0"
        />
        <p className="mx-auto mt-4 max-w-[52ch] text-[1rem] leading-[1.75] text-text-muted">
          {t.rich("prose", {
            mailLink: (chunks) => (
              <a
                href={`mailto:${siteConfig.email}`}
                className="text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
              >
                {chunks}
              </a>
            ),
          })}
        </p>
        <a
          href={`mailto:${siteConfig.email}`}
          className={cn(
            buttonVariants({ variant: "outline", size: "lg" }),
            "mt-6 h-auto px-5 py-3 text-[1rem]",
          )}
        >
          {t("cta")}
        </a>
      </div>
    </Section>
  );
}
