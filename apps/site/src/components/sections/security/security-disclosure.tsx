import { getTranslations } from "next-intl/server";

import { Cmd } from "@/components/primitives/cards";
import {
  Line,
  Prompt,
  TerminalWindow,
  Tok,
} from "@/components/primitives/terminal";
import { Section } from "@/components/primitives/section";
import { siteConfig } from "@/config/site";

type Fact = { label: string; value: string };

export async function SecurityDisclosure() {
  const t = await getTranslations("security");
  const facts = t.raw("disclosure.facts") as Fact[];

  return (
    <Section id="escape-hatches" tone="raised">
      <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 sm:gap-12">
        <div>
          <h2 className="mb-3.5 text-[clamp(1.25rem,2.2vw,1.5625rem)] leading-[1.06]">
            {t("escapeHatches.title")}
          </h2>
          <p className="mb-5 max-w-[52ch] text-[1rem] leading-[1.75] text-text-muted">
            {t.rich("escapeHatches.prose", {
              cmd: (chunks) => <Cmd>{chunks}</Cmd>,
            })}
          </p>
          <TerminalWindow chrome={false}>
            <Line>
              <Prompt />
              mtmux start <Tok kind="flag">--local</Tok>
            </Line>
            <Line>
              <Prompt />
              <Tok kind="keyword">MTMUX_API_URL</Tok>=
              <Tok kind="value">https://mtmux.internal</Tok> mtmux
            </Line>
            <Line>
              <Prompt />
              mtmux devices{" "}
              <Tok kind="comment"># {t("escapeHatches.devicesComment")}</Tok>
            </Line>
          </TerminalWindow>
        </div>
        <div id="disclosure">
          <h2 className="mb-3.5 text-[clamp(1.25rem,2.2vw,1.5625rem)] leading-[1.06]">
            {t("disclosure.title")}
          </h2>
          <p className="mb-5 max-w-[52ch] text-[1rem] leading-[1.75] text-text-muted">
            {t.rich("disclosure.prose", {
              addr: siteConfig.securityEmail,
              email: (chunks) => (
                <a
                  href={`mailto:${siteConfig.securityEmail}`}
                  className="text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
                >
                  {chunks}
                </a>
              ),
            })}
          </p>
          <dl className="grid gap-2.5 text-[0.9375rem]">
            {facts.map((fact, index) => (
              <div
                key={fact.label}
                className={
                  index < facts.length - 1
                    ? "flex items-center justify-between gap-3 border-b border-line-subtle pb-2.5 text-text-muted"
                    : "flex items-center justify-between gap-3 text-text-muted"
                }
              >
                <dt>{fact.label}</dt>
                <dd className="text-text">{fact.value}</dd>
              </div>
            ))}
          </dl>
          {/* The "no audit yet" line is the most important sentence on this
              page. Claiming a review that has not happened is indefensible,
              and saying so plainly is cheaper than being caught. */}
          <p className="mt-5 border-s-2 border-line-strong ps-4 text-[0.875rem] leading-[1.75] text-text-subtle">
            {t("disclosure.auditNote")}
          </p>
        </div>
      </div>
    </Section>
  );
}
