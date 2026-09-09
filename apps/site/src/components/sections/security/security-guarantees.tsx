import { getTranslations } from "next-intl/server";

import { HairlineCell, HairlineGrid, Cmd } from "@/components/primitives/cards";
import { Section, SectionHeading } from "@/components/primitives/section";
import { inlineLink } from "@/lib/rich-links";

type GuaranteeCell = { title: string; description: string };

export async function SecurityGuarantees() {
  const t = await getTranslations("security.guarantees");
  const cells = t.raw("cells") as GuaranteeCell[];

  return (
    <Section id="guarantees" tone="raised">
      <SectionHeading title={t("title")} />
      <HairlineGrid minColumnWidth="17rem" className="mt-8">
        {cells.map((cell, index) => (
          <HairlineCell key={cell.title}>
            <p className="mb-2 text-[1rem] font-600 text-text-strong">
              {cell.title}
            </p>
            <p className="text-[0.875rem] leading-[1.7] text-text-muted">
              {t.rich(`cells.${index}.description`, {
                cmd: (chunks) => <Cmd>{chunks}</Cmd>,
                // Only the "nothing to port-forward" cell carries a <post> tag.
                post: inlineLink("/blog/tmux-ssh"),
              })}
            </p>
          </HairlineCell>
        ))}
      </HairlineGrid>
    </Section>
  );
}
