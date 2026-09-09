import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { Cmd } from "@/components/primitives/cards";
import { Accent, Section } from "@/components/primitives/section";
import { buttonVariants } from "@/components/ui/button";
import { CopyInstall } from "@/components/site/copy-install";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

const richHandlers = {
  accent: (chunks: ReactNode) => <Accent>{chunks}</Accent>,
  cmd: (chunks: ReactNode) => <Cmd>{chunks}</Cmd>,
  code: (chunks: ReactNode) => <Cmd>{chunks}</Cmd>,
};

/**
 * The closing call to action every marketing page ends on: a headline, a
 * short lead line, and the install command.
 *
 * `showDocsLink` switches on the fuller, home-page treatment — a background
 * glow, a wider column and a secondary "read the docs" button — for the page
 * that wants its closing CTA to carry more weight. Other pages get the
 * compact treatment: no glow, install button only.
 */
export async function ClosingCta({
  namespace,
  tone = "base",
  showDocsLink = false,
}: {
  /** Translation namespace holding `title`, `description` and (if `showDocsLink`) `docsLink`. */
  namespace: string;
  tone?: "base" | "raised" | "sunken";
  showDocsLink?: boolean;
}) {
  const t = await getTranslations(namespace);

  return (
    <Section
      tone={tone}
      className={cn("relative", showDocsLink && "overflow-hidden")}
      innerClassName="text-center"
    >
      {showDocsLink ? (
        <div
          aria-hidden="true"
          className="bg-hero-mesh pointer-events-none absolute inset-0"
        />
      ) : null}
      <div
        className={cn(
          "relative mx-auto",
          showDocsLink ? "max-w-[47.5rem]" : "max-w-xl",
        )}
      >
        <h2
          className={cn(
            showDocsLink
              ? "text-[clamp(1.625rem,3.8vw,2.75rem)] leading-[1.02]"
              : "text-[clamp(1.5rem,3.2vw,2.3125rem)] leading-[1.04]",
          )}
        >
          {t.rich("title", richHandlers)}
        </h2>
        <p
          className={cn(
            "mx-auto max-w-[44ch] leading-[1.7] text-text-muted",
            showDocsLink ? "mt-4.5 text-[1.125rem]" : "mt-4 text-[1.0625rem]",
          )}
        >
          {t.rich("description", richHandlers)}
        </p>
        <div
          className={cn(
            "flex flex-wrap items-center justify-center gap-3",
            showDocsLink ? "mt-7.5" : "mt-7",
          )}
        >
          <CopyInstall size="lg" variant="solid" />
          {showDocsLink ? (
            <Link
              href="/docs"
              className={cn(
                buttonVariants({ size: "lg" }),
                "h-auto px-5.5 py-3 text-[1.0625rem]",
              )}
            >
              {t("docsLink")}
            </Link>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
