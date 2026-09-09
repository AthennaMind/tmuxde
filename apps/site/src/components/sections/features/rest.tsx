import { getTranslations } from "next-intl/server";

import { Cmd, HairlineCell, HairlineGrid } from "@/components/primitives/cards";
import { Eyebrow } from "@/components/primitives/section";
import { inlineLink } from "@/lib/rich-links";

type Cell = { title: string; body: string };

export async function FeaturesRest() {
  const t = await getTranslations("features.rest");
  const cells = t.raw("cells") as Cell[];

  return (
    <div>
      <div className="mb-8 max-w-xl sm:mb-11">
        <Eyebrow>{t("eyebrow")}</Eyebrow>
        <h2 className="text-[clamp(1.375rem,2.7vw,1.875rem)] leading-[1.06]">
          {t("title")}
        </h2>
      </div>
      <HairlineGrid minColumnWidth="15.5rem">
        {cells.map((cell, i) => (
          <HairlineCell key={i}>
            <h3 className="text-[1.0625rem] font-600 text-text-strong">
              {cell.title}
            </h3>
            <p className="mt-2 text-[0.9375rem] leading-[1.7] text-text-muted">
              {t.rich(`cells.${i}.body`, {
                code: (chunks) => <Cmd>{chunks}</Cmd>,
                // Only the sessions/windows/panes cell carries a <post> tag.
                post: inlineLink("/blog/tmux-commands"),
              })}
            </p>
          </HairlineCell>
        ))}
      </HairlineGrid>
    </div>
  );
}
