import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { Cmd, Keycap } from "@/components/primitives/cards";
import { Eyebrow } from "@/components/primitives/section";
import { inlineLink } from "@/lib/rich-links";

const codeHandlers = {
  code: (chunks: ReactNode) => <Cmd>{chunks}</Cmd>,
};

const proseHandlers = {
  ...codeHandlers,
  post: inlineLink("/blog/tmux-from-phone"),
};

export async function FeaturesInput() {
  const t = await getTranslations("features.input");

  const topRow = ["prefix", "esc", "ctrl", "alt", "tab"] as const;
  const bottomRow = ["slash", "left", "down", "up", "right"] as const;
  const bullets = t.raw("bullets") as string[];
  const macros = t.raw("macros") as string[];

  return (
    <div className="grid items-center gap-10 sm:grid-cols-2 sm:gap-14">
      <div>
        <Eyebrow>{t("eyebrow")}</Eyebrow>
        <h2 className="text-[clamp(1.375rem,2.7vw,1.875rem)] leading-[1.06]">
          {t("title")}
        </h2>
        <p className="mt-3.5 max-w-[50ch] text-[1.0625rem] leading-[1.75] text-text-muted">
          {t.rich("prose", proseHandlers)}
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
        className="grid gap-2 rounded-xl border border-line bg-surface-sunken p-4 sm:p-5"
      >
        <div className="grid grid-cols-5 gap-1.5">
          {topRow.map((k) => (
            <Keycap key={k} active={k === "prefix"}>
              {t(`keys.${k}`)}
            </Keycap>
          ))}
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {bottomRow.map((k) => (
            <Keycap key={k}>{t(`keys.${k}`)}</Keycap>
          ))}
        </div>
        <div className="mt-1.5 font-mono text-[0.8125rem] tracking-[0.08em] text-text-faint">
          {t("macrosLabel")}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {macros.map((macro, i) => (
            <span
              key={i}
              className="rounded-md border border-dashed border-line-strong bg-surface-panel px-3 py-2 font-mono text-[0.8125rem] text-text-muted"
            >
              {macro}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
