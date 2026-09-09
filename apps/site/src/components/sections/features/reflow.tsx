import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { Cmd } from "@/components/primitives/cards";
import { Eyebrow } from "@/components/primitives/section";

const codeHandlers = {
  code: (chunks: ReactNode) => <Cmd>{chunks}</Cmd>,
};

export async function FeaturesReflow() {
  const t = await getTranslations("features.layout");
  const bullets = t.raw("bullets") as string[];

  return (
    <div className="grid items-center gap-10 sm:grid-cols-2 sm:gap-14">
      <div className="order-2">
        <Eyebrow>{t("eyebrow")}</Eyebrow>
        <h2 className="text-[clamp(1.375rem,2.7vw,1.875rem)] leading-[1.06]">
          {t("title")}
        </h2>
        <p className="mt-3.5 max-w-[50ch] text-[1.0625rem] leading-[1.75] text-text-muted">
          {t.rich("prose", codeHandlers)}
        </p>
        <ul className="mt-5 grid gap-2.5 text-[1rem] text-text-muted">
          {bullets.map((_, i) => (
            <li key={i} className="flex gap-2.5">
              <span aria-hidden="true" className="text-brand">
                ›
              </span>
              <span>{t.rich(`bullets.${i}`, codeHandlers)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div
        role="img"
        aria-label={t("diagramAlt")}
        className="flex items-center justify-center gap-4"
      >
        <div className="flex flex-col items-center gap-2.5">
          <div className="grid h-[150px] w-[150px] grid-cols-2 grid-rows-2 gap-[3px] rounded-lg border border-line bg-line p-[3px]">
            <div className="rounded-[3px] bg-surface-sunken" />
            <div className="row-span-2 rounded-[3px] border border-line-strong bg-surface-sunken" />
            <div className="rounded-[3px] bg-surface-sunken" />
          </div>
          <span className="font-mono text-[0.8125rem] text-text-faint">
            {t("before")}
          </span>
        </div>

        <span aria-hidden="true" className="text-brand">
          →
        </span>

        <div className="flex flex-col items-center gap-2.5">
          <div className="grid h-[150px] w-[84px] grid-rows-[2fr_1fr_1fr] gap-[3px] rounded-lg border border-line bg-line p-[3px]">
            <div className="rounded-[3px] border border-line-strong bg-surface-sunken" />
            <div className="rounded-[3px] bg-surface-sunken" />
            <div className="rounded-[3px] bg-surface-sunken" />
          </div>
          <span className="font-mono text-[0.8125rem] text-text-faint">
            {t("after")}
          </span>
        </div>
      </div>
    </div>
  );
}
