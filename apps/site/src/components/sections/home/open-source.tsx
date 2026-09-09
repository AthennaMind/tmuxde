import {
  BookOpen,
  Container,
  GitBranch,
  Package,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { Cmd, HairlineCell, HairlineGrid } from "@/components/primitives/cards";
import { Section, SectionHeading } from "@/components/primitives/section";
import {
  Line,
  Prompt,
  TerminalWindow,
  Tok,
} from "@/components/primitives/terminal";
import { siteConfig } from "@/config/site";

/**
 * Open source and self-hosting.
 *
 * The home page argued the product for eight sections without once saying
 * where the code is or how to run it without us — which is the first question
 * the audience for a remote-shell tool asks, and the one the whole
 * architecture was built to answer well.
 *
 * The three degrees are deliberately the same three, in the same order, as
 * `apps/docs/content/docs/self-hosting.mdx`. Someone who reads this section and
 * then opens the docs should find the page they were promised, not a different
 * taxonomy of the same facts.
 *
 * Every link is an external one to the repo, the registry or the docs origin,
 * so this is also where the site finally passes crawl equity to the places
 * that host the thing it is selling.
 */

/** The three degrees, keyed to `home.openSource.degrees.*`. */
const DEGREES = [
  { key: "cli", command: "npm i -g mtmux" },
  { key: "local", command: "mtmux start --local" },
  { key: "broker", command: "docker compose up" },
] as const;

/** The link rail. Icons live here; labels and blurbs are translated. */
const LINKS: ReadonlyArray<{
  key: string;
  href: string;
  icon: ReactNode;
}> = [
  { key: "repo", href: siteConfig.social.github, icon: <GitBranch /> },
  { key: "selfHosting", href: siteConfig.docsSelfHosting, icon: <BookOpen /> },
  { key: "images", href: siteConfig.social.packages, icon: <Container /> },
  { key: "npm", href: siteConfig.npmUrl, icon: <Package /> },
  { key: "security", href: siteConfig.docsSecurity, icon: <ShieldCheck /> },
  { key: "license", href: siteConfig.social.license, icon: <Scale /> },
];

export async function OpenSource() {
  const t = await getTranslations("home.openSource");

  return (
    <Section id="open-source">
      <SectionHeading
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        level={2}
        size="md"
        align="center"
        className="mb-10 sm:mb-14"
      />

      {/* Three across, so the row fills — and so the three degrees read as
          alternatives rather than as a sequence you work through. */}
      <HairlineGrid minColumnWidth="17rem">
        {DEGREES.map((degree, index) => (
          <HairlineCell key={degree.key} className="flex flex-col p-6 sm:p-7">
            <span
              aria-hidden="true"
              className="font-mono text-[0.8125rem] font-600 text-brand"
            >
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-3.5 font-sans text-[1.125rem] font-600 tracking-[-0.01em] text-text-strong">
              {t(`degrees.${degree.key}.title`)}
            </h3>
            <p className="mt-2.5 text-[1rem] leading-[1.7] text-text-muted">
              {t.rich(`degrees.${degree.key}.description`, {
                cmd: (chunks) => <Cmd>{chunks}</Cmd>,
              })}
            </p>
            <p className="mt-auto pt-5">
              <Cmd>{degree.command}</Cmd>
            </p>
          </HairlineCell>
        ))}
      </HairlineGrid>

      {/* The whole procedure, because it really is this short — and because a
          claim about self-hosting is worth less than four lines of it. */}
      <div className="mt-10 grid items-center gap-7 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-12">
        <TerminalWindow
          title={t("compose.title")}
          bodyClassName="text-[0.8125rem] leading-[1.75] sm:text-[0.875rem]"
        >
          <Line tone="faint">
            <Prompt />
            git clone <Tok kind="path">{siteConfig.repo}.git</Tok>
          </Line>
          <Line tone="faint">
            <Prompt />
            cd mtmux
          </Line>
          <Line tone="faint">
            <Prompt />
            cp .env.example .env
          </Line>
          <Line>
            <Prompt />
            docker compose up
          </Line>
          <Line> </Line>
          <Line tone="muted">
            <Tok kind="flag">api</Tok> broker on :24400 ·{" "}
            <Tok kind="flag">web</Tok> client on :24100
          </Line>
        </TerminalWindow>
        <p className="text-[1.0625rem] leading-[1.75] text-text-muted">
          {t.rich("compose.note", {
            cmd: (chunks) => <Cmd>{chunks}</Cmd>,
          })}
        </p>
      </div>

      <HairlineGrid className="mt-10" minColumnWidth="22rem">
        {LINKS.map((link) => (
          <HairlineCell key={link.key} className="p-0">
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer noopener"
              className="group flex h-full items-start gap-3.5 p-5 transition-colors hover:bg-surface-panel"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 grid size-8 flex-none place-items-center rounded-lg bg-brand-soft text-brand transition-colors group-hover:bg-brand group-hover:text-brand-contrast [&_svg]:size-4"
              >
                {link.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2 font-sans text-[1rem] font-600 tracking-[-0.01em] text-text-strong">
                  <span className="min-w-0 flex-1">
                    {t(`links.${link.key}.title`)}
                  </span>
                  <span
                    aria-hidden="true"
                    className="flex-none text-text-faint transition-colors group-hover:text-brand"
                  >
                    ↗
                  </span>
                </span>
                <span className="mt-1 block text-[0.9375rem] leading-[1.6] text-text-muted">
                  {t(`links.${link.key}.description`)}
                </span>
              </span>
            </a>
          </HairlineCell>
        ))}
      </HairlineGrid>
    </Section>
  );
}
