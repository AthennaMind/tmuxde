import { KeyRound, Lock, Signal } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Cmd } from "@/components/primitives/cards";
import { QrCode } from "@/components/primitives/qr-code";
import { Accent } from "@/components/primitives/section";
import { Cursor, Line, Prompt, TerminalWindow, Tok } from "@/components/primitives/terminal";
import { CopyInstall } from "@/components/site/copy-install";
import { buttonVariants } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { inlineLink } from "@/lib/rich-links";
import { cn } from "@/lib/utils";

const TRUST_ICONS = [KeyRound, Lock, Signal];

/**
 * The hero. One centred column.
 *
 * It was a two-column split — argument left, terminal right — which read as
 * two unrelated things sharing a row: the headline hung off the left gutter,
 * the terminal floated at the far right, and the eye had no obvious place to
 * start. Centring gives it one axis. The order down that axis is the order a
 * visitor needs it in: what it is, what it costs you to try, then the proof.
 *
 * The proof is the banner the CLI actually prints, drawn rather than
 * screenshotted so every word in it is translatable and every colour is a
 * token — and the QR in it is a real, scannable code (`qr-glyph.ts`), not a
 * picture of one. The banner is laid out two-column exactly like
 * `twoColumn()` in `apps/cli/src/banner.ts`.
 *
 * The definitional paragraph sits last: it is what an answer engine quotes,
 * and it must not push `CopyInstall` off the first screen to get there.
 */
export async function HomeHero() {
  const t = await getTranslations("home.hero");
  const trust = [t("trust.noSsh"), t("trust.e2e"), t("trust.cellular")];

  return (
    <header className="relative overflow-hidden border-b border-line-subtle">
      {/* Two washes and a hairline grid. Both are token-driven, so the backdrop
          re-tints itself in light mode instead of needing a second treatment. */}
      <div
        aria-hidden="true"
        className="bg-hero-mesh pointer-events-none absolute inset-0"
      />
      <div
        aria-hidden="true"
        className="bg-grid pointer-events-none absolute inset-0 opacity-[0.35] [mask-image:radial-gradient(ellipse_at_50%_0%,black,transparent_72%)]"
      />

      <div className="container-content relative flex flex-col items-center pt-(--spacing-section) pb-(--spacing-section) text-center">
        <p className="inline-flex items-center gap-2.5 rounded-full border border-line bg-surface-raised/70 py-1.5 pe-3.5 ps-1.5 font-mono text-[0.875rem] text-text-subtle shadow-ambient backdrop-blur">
          <span className="rounded-full bg-brand px-2 py-0.5 text-[0.8125rem] font-700 text-brand-contrast">
            v{siteConfig.version}
          </span>
          {t("badge")}
          <span aria-hidden="true" className="text-text-faint">
            →
          </span>
        </p>

        <h1 className="mt-6 max-w-[24ch] text-balance text-[clamp(2rem,4.2vw,3.125rem)] leading-[1.06]">
          {t.rich("title", { accent: (chunks) => <Accent>{chunks}</Accent> })}
        </h1>

        <p className="mt-5 max-w-[54ch] text-balance text-[clamp(1.125rem,1.7vw,1.375rem)] leading-[1.55] text-text-muted">
          {t("subhead")}
        </p>

        <div className="mt-8 flex w-full max-w-[34rem] flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
          <CopyInstall size="lg" variant="solid" className="justify-center" />
          <Link
            href="/docs"
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
              "h-auto justify-center px-5.5 py-3.5 text-[1.0625rem]",
            )}
          >
            {t("quickstart")}
          </Link>
        </div>

        <ul className="mt-7 flex flex-wrap justify-center gap-x-6 gap-y-2.5 font-mono text-[0.875rem] text-text-subtle">
          {trust.map((item, index) => {
            const Icon = TRUST_ICONS[index]!;
            return (
              <li key={item} className="flex items-center gap-2">
                <Icon aria-hidden="true" className="size-4 text-brand" />
                {item}
              </li>
            );
          })}
        </ul>

        <div className="mt-11 w-full max-w-[36rem]">
          <TerminalWindow
            title={t("terminal.title")}
            className="text-start"
            bodyClassName="text-[0.8125rem] leading-[1.7] sm:text-[0.875rem]"
          >
            <Line tone="faint">
              <Prompt />
              {siteConfig.install}
            </Line>
            <Line tone="faint">
              {"+ mtmux@"}
              {siteConfig.version}
            </Line>
            <Line> </Line>
            <Line>
              <Prompt />
              mtmux
            </Line>
            <Line> </Line>

            {/* The banner: code on the left, the way to do it by hand beside
                it — the same two columns `banner.ts` prints. */}
            <div className="flex flex-wrap items-center gap-x-7 gap-y-5 py-2 ps-2">
              <QrCode label={t("terminal.qrLabel")} className="w-[9rem] shrink-0" />
              <div className="space-y-1">
                <Line tone="strong">{t("terminal.scan")}</Line>
                <Line> </Line>
                <Line tone="faint">
                  {t("terminal.or")} <Tok kind="path">{siteConfig.appHost}</Tok>
                </Line>
                <Line tone="faint">
                  {t("terminal.code")} <Tok kind="value">48 29 13</Tok>
                </Line>
              </div>
            </div>

            <Line> </Line>
            <Line tone="muted">
              {t("terminal.waiting")}
              <Cursor />
            </Line>
          </TerminalWindow>

          <p className="mt-3.5 font-mono text-[0.8125rem] text-text-faint">
            {t("terminal.caption")}
          </p>
        </div>

        {/* The definitional paragraph. It is the passage an answer engine
            quotes when asked "what is mtmux", so it names the product, says
            what it is, and gives the two commands — in that order, in one
            sentence each. */}
        <p className="mt-11 max-w-[64ch] text-[1rem] leading-[1.8] text-text-muted">
          {t.rich("answer", {
            cmd: (chunks) => <Cmd>{chunks}</Cmd>,
            post: inlineLink("/blog/tmux-from-phone"),
          })}
        </p>
      </div>
    </header>
  );
}
