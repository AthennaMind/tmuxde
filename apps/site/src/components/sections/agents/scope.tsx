import { getTranslations } from "next-intl/server";

import { Cmd } from "@/components/primitives/cards";
import { Section } from "@/components/primitives/section";
import { inlineLink } from "@/lib/rich-links";

/**
 * Two columns: what mtmux does, and what it deliberately does not.
 *
 * The second column is the more valuable of the two. "Does it notify me?" is
 * the question this page exists to answer, and answering it with a plain no —
 * next to a suggestion of what would actually page you — costs one visitor and
 * earns the trust of the rest.
 */
export async function AgentScope() {
  const t = await getTranslations("agents.scope");
  const does = t.raw("does.items") as string[];
  const doesNot = t.raw("doesNot.items") as string[];

  return (
    <Section tone="raised">
      <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 sm:gap-12">
        <div>
          <h2 className="mb-5 text-[clamp(1.25rem,2.2vw,1.5625rem)] leading-[1.06]">
            {t("does.title")}
          </h2>
          <ul className="grid gap-3 text-[1rem] leading-[1.7] text-text-muted">
            {does.map((item) => (
              <li key={item} className="flex gap-3">
                <span aria-hidden="true" className="text-brand">
                  ✓
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="mb-5 text-[clamp(1.25rem,2.2vw,1.5625rem)] leading-[1.06]">
            {t("doesNot.title")}
          </h2>
          <ul className="grid gap-3 text-[1rem] leading-[1.7] text-text-muted">
            {doesNot.map((item) => (
              <li key={item} className="flex gap-3">
                <span aria-hidden="true" className="text-text-faint">
                  —
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-10 max-w-[68ch] border-t border-line-subtle pt-6 text-[1rem] leading-[1.75] text-text-subtle">
        {t.rich("note", {
          cmd: (chunks) => <Cmd>{chunks}</Cmd>,
          post: inlineLink("/blog/tmux-notifications"),
        })}
      </p>
    </Section>
  );
}
