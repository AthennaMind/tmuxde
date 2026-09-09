import { getTranslations } from "next-intl/server";

import { Cmd } from "@/components/primitives/cards";
import {
  Line,
  Prompt,
  TerminalWindow,
  Tok,
} from "@/components/primitives/terminal";
import { siteConfig } from "@/config/site";

/**
 * The literal command shown per step. Kept out of the message catalogue — it's
 * code, not prose — and exported so the page can reuse the exact same strings
 * when building the HowTo step text for structured data.
 *
 * Index-matched against `docs.quickstart.steps`, same as the CLI table.
 */
export const DOCS_QUICKSTART_COMMANDS = [
  "mtmux",
  `open ${siteConfig.appHost} and enter 48 29 13`,
  "mtmux status",
] as const;

type QuickstartStep = { label: string; comment: string };

export async function DocsQuickstart() {
  const t = await getTranslations("docs.quickstart");
  const steps = t.raw("steps") as QuickstartStep[];

  return (
    <section id="quickstart">
      <h2 className="mb-5 text-[clamp(1.3125rem,2.5vw,1.8125rem)] leading-[1.06]">
        {t("title")}
      </h2>
      <ol className="grid gap-3.5">
        {steps.map((step, index) => (
          <li
            key={step.label}
            className="grid grid-cols-[auto_1fr] items-start gap-4"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface-panel font-mono text-[0.8125rem] text-brand"
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="mb-2.5 text-[1rem] text-text-strong">
                {step.label}
              </p>
              <TerminalWindow>
                {index === 0 ? (
                  <Line>
                    <Prompt />
                    mtmux <Tok kind="comment"># {step.comment}</Tok>
                  </Line>
                ) : null}
                {index === 1 ? (
                  <Line>
                    <Tok kind="path">{siteConfig.appHost}</Tok> ·{" "}
                    <Tok kind="flag">48 29 13</Tok>{" "}
                    <Tok kind="comment"># {step.comment}</Tok>
                  </Line>
                ) : null}
                {index === 2 ? (
                  <Line>
                    <Prompt />
                    mtmux status <Tok kind="comment"># {step.comment}</Tok>
                  </Line>
                ) : null}
              </TerminalWindow>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex gap-3 rounded-lg border border-line-subtle border-s-2 border-s-brand bg-surface-panel px-4 py-3.5 text-[0.9375rem] leading-[1.75] text-text-muted">
        <span className="mt-0.5 shrink-0 font-mono text-[0.8125rem] font-500 tracking-[0.1em] text-brand uppercase">
          {t("note.label")}
        </span>
        <p>{t.rich("note.body", { cmd: (chunks) => <Cmd>{chunks}</Cmd> })}</p>
      </div>
    </section>
  );
}
