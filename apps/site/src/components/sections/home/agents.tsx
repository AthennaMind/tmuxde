import { getTranslations } from "next-intl/server";

import { HairlineCell, HairlineGrid } from "@/components/primitives/cards";
import {
  Accent,
  Section,
  SectionHeading,
} from "@/components/primitives/section";
import { Line, Tok, TerminalWindow } from "@/components/primitives/terminal";
import { Link } from "@/i18n/navigation";
import { inlineLink } from "@/lib/rich-links";

type Point = { title: string; body: string };

/**
 * The coding-agent section.
 *
 * The honest claim is *pull, not push*: mtmux has no watchers, no signatures
 * and no notifications, so this section shows what you actually get — the
 * agent's own pane, on a phone, with a prompt you can answer. The `honest`
 * note is deliberately part of the section rather than a footnote: the
 * question "does it ping me?" is the first one every visitor has, and
 * answering it plainly here is worth more than the sale a vaguer word would
 * make.
 *
 * The pane transcript is illustrative CLI output, not prose, so it is authored
 * here rather than in home.json.
 */
export async function Agents() {
  const t = await getTranslations("home.agents");
  const points = t.raw("points") as Point[];

  return (
    <Section tone="base">
      <SectionHeading
        eyebrow={t("eyebrow")}
        eyebrowTone="agent"
        title={t.rich("title", {
          accent: (chunks) => <Accent tone="agent">{chunks}</Accent>,
        })}
        description={t.rich("description", {
          post: inlineLink("/blog/stop-babysitting-coding-agents"),
        })}
        level={2}
        size="md"
        align="center"
        className="mb-10 max-w-3xl sm:mb-14"
      />

      <div className="grid items-start gap-7 lg:grid-cols-2 lg:gap-9">
        <div>
          <TerminalWindow title={t("terminalTitle")}>
            <Line tone="faint">{"  ⏺ Update(src/auth/middleware.ts)"}</Line>
            <Line>
              {"  "}
              <Tok kind="added">+ 24</Tok> <Tok kind="removed">- 11</Tok>{" "}
              <Tok kind="comment">· 14 files changed</Tok>
            </Line>
            <Line> </Line>
            <Line tone="faint">{"  ⏺ Bash(pnpm test)"}</Line>
            <Line>
              {"  "}
              <Tok kind="comment">27 passed, 0 failed</Tok>
            </Line>
            <Line> </Line>
            <Line tone="strong">{"  Apply patch to migrations/0042.sql?"}</Line>
            <Line>
              {"  "}
              <Tok kind="keyword">❯ 1. Yes</Tok>
            </Line>
            <Line tone="faint">
              {"    2. No, tell Claude what to do differently"}
            </Line>
          </TerminalWindow>

          <div className="mt-4 flex gap-3 rounded-lg border border-line-subtle border-s-2 border-s-line-strong bg-surface-panel px-4 py-3.5 text-[0.9375rem] leading-[1.7] text-text-muted">
            <span className="mt-0.5 shrink-0 font-mono text-[0.8125rem] font-500 tracking-[0.1em] text-text-faint uppercase">
              {t("honest.label")}
            </span>
            <p>
              {t.rich("honest.body", {
                post: inlineLink("/blog/coding-agent-notifications"),
              })}
            </p>
          </div>
        </div>

        <div>
          <HairlineGrid minColumnWidth="15rem">
            {points.map((point) => (
              <HairlineCell key={point.title}>
                {/* An `h3`, styled to render exactly as the `<p>` it replaced:
                    the base `h1–h4` rule applies the display face and a tight
                    tracking, so both have to be cancelled explicitly. */}
                <h3 className="mb-1.5 font-sans text-[1rem] font-600 tracking-[-0.01em] text-text-strong">
                  {point.title}
                </h3>
                <p className="text-[0.875rem] leading-[1.7] text-text-muted">
                  {point.body}
                </p>
              </HairlineCell>
            ))}
          </HairlineGrid>

        </div>
      </div>

      <div className="mt-8 text-center">
        <Link
          href="/agents"
          className="text-[1rem] text-brand underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-brand"
        >
          {t("readMore")} →
        </Link>
      </div>
    </Section>
  );
}
