import { EyeOff, KeyRound, Server, ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { HairlineCell, HairlineGrid, Cmd } from "@/components/primitives/cards";
import { Section, SectionHeading } from "@/components/primitives/section";
import { Link } from "@/i18n/navigation";

const CELL_INDEXES = [0, 1, 2, 3] as const;

/** One glyph per guarantee, in the order the cells are written. */
const CELL_ICONS = [ShieldCheck, Server, KeyRound, EyeOff];

/**
 * Centred header over a four-across grid, like every other section on the
 * page. It used to be a two-column split — heading left, cells right — which
 * on a wide viewport left the heading marooned in an empty half.
 */
export async function Security() {
  const t = await getTranslations("home.security");

  return (
    <Section tone="raised">
      <SectionHeading
        eyebrow={t("eyebrow")}
        eyebrowTone="stalled"
        title={t("title")}
        description={t("description")}
        level={2}
        size="md"
        align="center"
        className="mb-10 sm:mb-14"
      />

      <HairlineGrid minColumnWidth="15.5rem">
        {CELL_INDEXES.map((index) => (
          <HairlineCell key={index} className="p-6">
            {(() => {
              const Icon = CELL_ICONS[index]!;
              return (
                <Icon
                  aria-hidden="true"
                  className="mb-4 size-5 text-signal-stalled"
                />
              );
            })()}
            {/* See the note in `agents.tsx`: these cell titles are weight
                400, so the base heading rule's face *and* tracking are both
                cancelled to keep the render identical. */}
            <h3 className="mb-1.5 font-sans text-[1.0625rem] font-normal tracking-normal text-text-strong">
              {t(`cells.${index}.title`)}
            </h3>
            <p className="text-[0.9375rem] leading-[1.65] text-text-muted">
              {t.rich(`cells.${index}.description`, {
                cmd: (chunks) => <Cmd>{chunks}</Cmd>,
              })}
            </p>
          </HairlineCell>
        ))}
      </HairlineGrid>

      <div className="mt-8 text-center">
        <Link
          href="/security"
          className="inline-flex items-center gap-2 rounded-lg border border-line px-4.5 py-2.5 text-[1rem] text-text transition-colors hover:border-brand hover:text-brand"
        >
          {t("readThreatModel")} →
        </Link>
      </div>
    </Section>
  );
}
