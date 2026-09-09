import {
  Command,
  Palette,
  RotateCcw,
  Search,
  SquareStack,
  Zap,
} from "lucide-react";
import { getTranslations } from "next-intl/server";

import { FeatureCard } from "@/components/primitives/cards";
import { SectionHeading, Section } from "@/components/primitives/section";
import { Link } from "@/i18n/navigation";

const ICONS = [Command, SquareStack, Palette, Search, RotateCcw, Zap];

export async function Fidelity() {
  const t = await getTranslations("home.fidelity");
  const features = t.raw("features") as Array<{
    title: string;
    description: string;
  }>;

  return (
    <Section tone="base">
      <SectionHeading
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        level={2}
        size="md"
        align="center"
        className="mb-10 sm:mb-14"
      />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(19.5rem,100%),1fr))] gap-4">
        {features.map((feature, index) => {
          const Icon = ICONS[index % ICONS.length];
          return (
            <FeatureCard
              key={feature.title}
              icon={<Icon aria-hidden="true" />}
              title={feature.title}
            >
              {feature.description}
            </FeatureCard>
          );
        })}
      </div>

      <div className="mt-8 text-center">
        <Link
          href="/features"
          className="text-[1rem] text-brand underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-brand"
        >
          {t("allFeatures")} →
        </Link>
      </div>
    </Section>
  );
}
