import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { Cmd } from "@/components/primitives/cards";
import { Eyebrow } from "@/components/primitives/section";
import { Line, Prompt, TerminalWindow } from "@/components/primitives/terminal";
import { inlineLink } from "@/lib/rich-links";
import { cn } from "@/lib/utils";

const richHandlers = {
  code: (chunks: ReactNode) => <Cmd>{chunks}</Cmd>,
};

/**
 * The two scenarios whose copy carries a `<post>` tag, keyed by scenario.
 *
 * The hrefs are literal strings here so `src/lib/link-graph.ts` can read the
 * `/use-cases` → post edge out of this file at build time.
 */
const POST_LINKS: Partial<Record<string, (chunks: ReactNode) => ReactNode>> = {
  unattendedAgents: inlineLink("/blog/stop-babysitting-coding-agents"),
  commuting: inlineLink("/blog/tmux-from-phone"),
};

/**
 * Two shapes share one renderer.
 *
 * `lineOne`/`lineThree`/`command` are things *you* typed, so they get a prompt.
 * `lineTwo`/`output` are what the machine printed back. `question`/`options`
 * are a pane mid-prompt — no shell prompt, because an agent asking you
 * something is not a command line.
 */
type Terminal = {
  title: string;
  lineOne?: string;
  lineTwo?: string;
  lineThree?: string;
  command?: string;
  output?: string;
  question?: string;
  options?: string;
};

type Scenario = {
  index: string;
  eyebrow: string;
  title: string;
  body1: string;
  body2: string;
  terminal?: Terminal;
};

/**
 * Fixed render order — mirrors the key order in `messages/en/use-cases.json`.
 *
 * The lead scenario is the agent one because it is why most people arrive, and
 * it is now illustrated with the agent's own pane rather than a notification
 * card: the product shows you the pane, it does not send you a card.
 */
const SCENARIO_KEYS = [
  "unattendedAgents",
  "onCall",
  "commuting",
  "travellingLight",
  "longJobs",
  "behindNat",
] as const;

export async function UseCasesScenarios() {
  const t = await getTranslations("use-cases");

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {SCENARIO_KEYS.map((key) => {
        const scenario = t.raw(`scenarios.${key}`) as Scenario;
        const isLead = key === "unattendedAgents";
        const postLink = POST_LINKS[key];
        const handlers = postLink
          ? { ...richHandlers, post: postLink }
          : richHandlers;

        return (
          <article
            key={key}
            className={cn(
              "flex flex-col rounded-xl border border-line bg-surface-raised p-6 sm:p-7",
              isLead && "sm:col-span-2 lg:row-span-2 lg:p-9",
            )}
          >
            <div className="mb-4 flex items-baseline gap-2.5">
              <span className="font-mono text-[0.8125rem] text-text-faint">
                {scenario.index}
              </span>
              <Eyebrow className="mb-0">{scenario.eyebrow}</Eyebrow>
            </div>
            <h2
              className={cn(
                "leading-[1.12] text-text-strong",
                isLead
                  ? "text-[clamp(1.5rem,2.8vw,1.9375rem)]"
                  : "text-[1.25rem]",
              )}
            >
              {scenario.title}
            </h2>
            <p className="mt-3 text-[1rem] leading-[1.75] text-text-muted">
              {t.rich(`scenarios.${key}.body1`, handlers)}
            </p>
            <p className="mt-2.5 text-[1rem] leading-[1.75] text-text-subtle">
              {t.rich(`scenarios.${key}.body2`, handlers)}
            </p>

            {scenario.terminal ? (
              <TerminalWindow title={scenario.terminal.title} className="mt-5">
                {scenario.terminal.lineOne ? (
                  <Line>
                    <Prompt />
                    {scenario.terminal.lineOne}
                  </Line>
                ) : null}
                {scenario.terminal.lineTwo ? (
                  <Line tone="muted">{scenario.terminal.lineTwo}</Line>
                ) : null}
                {scenario.terminal.lineThree ? (
                  <Line>
                    <Prompt />
                    {scenario.terminal.lineThree}
                  </Line>
                ) : null}
                {scenario.terminal.question ? (
                  <Line tone="strong">{scenario.terminal.question}</Line>
                ) : null}
                {scenario.terminal.options ? (
                  <Line tone="muted">{scenario.terminal.options}</Line>
                ) : null}
                {scenario.terminal.command ? (
                  <Line>
                    <Prompt />
                    {scenario.terminal.command}
                  </Line>
                ) : null}
                {scenario.terminal.output ? (
                  <Line tone="muted">{scenario.terminal.output}</Line>
                ) : null}
              </TerminalWindow>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
