import { getTranslations } from "next-intl/server";

import { TerminalReplay } from "@/components/demo/terminal-replay";
import { Section, SectionHeading } from "@/components/primitives/section";
import { CHAPTERS } from "@/lib/demo/cast";
import { inlineLink } from "@/lib/rich-links";

/**
 * The home page's demo — what `HowItWorks` used to be.
 *
 * It replaced that section rather than joining it: the step cards became the
 * chapter rail and the static banner became chapter 2, so the page keeps its
 * alternating `base`/`raised` rhythm and does not show the same banner twice.
 *
 * This wrapper stays a server component. Only `TerminalReplay` is a client
 * island, which is what keeps `/` statically rendered — a `ƒ (Dynamic)` in the
 * build output is a regression here.
 *
 * The chapter blurbs are built here rather than inside the island so both blog
 * links stay real `next-intl` `Link`s with literal hrefs at the call site,
 * which is the only form `link-graph.ts` can see.
 */
export async function Demo() {
  const t = await getTranslations("home.demo");

  const chapters = [
    {
      id: CHAPTERS[0],
      title: t("chapters.install.title"),
      description: t("chapters.install.description"),
    },
    {
      id: CHAPTERS[1],
      title: t("chapters.pair.title"),
      description: t("chapters.pair.description"),
    },
    {
      id: CHAPTERS[2],
      title: t("chapters.attach.title"),
      description: t.rich("chapters.attach.description", {
        post: inlineLink("/blog/tmux-commands"),
      }),
    },
    {
      id: CHAPTERS[3],
      title: t("chapters.move.title"),
      description: t("chapters.move.description"),
    },
    {
      id: CHAPTERS[4],
      title: t("chapters.agent.title"),
      description: t("chapters.agent.description"),
    },
  ];

  return (
    <Section tone="base">
      <SectionHeading
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t.rich("description", {
          post: inlineLink("/blog/tmux-in-browser"),
        })}
        level={2}
        size="md"
        align="center"
        className="mb-10 sm:mb-14"
      />

      <TerminalReplay
        chapters={chapters}
        labels={{
          play: t("transport.play"),
          pause: t("transport.pause"),
          restart: t("transport.restart"),
          progress: t("transport.progress"),
          reducedNote: t("transport.reducedNote"),
          description: t("a11y.description"),
          // Raw: the island substitutes `{title}` itself, so formatting it
          // here only produces a missing-variable error in the log.
          nowShowing: t.raw("a11y.nowShowing") as string,
          laptopTitle: t("terminalTitle"),
        }}
      />
    </Section>
  );
}
