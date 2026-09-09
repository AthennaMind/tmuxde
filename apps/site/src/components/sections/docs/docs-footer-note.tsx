import { getTranslations } from "next-intl/server";

import { siteConfig } from "@/config/site";

export async function DocsFooterNote() {
  const t = await getTranslations("docs");

  return (
    <p className="border-t border-line-subtle pt-8 text-[1rem] text-text-subtle">
      {t.rich("footerNote", {
        addr: siteConfig.email,
        discussions: (chunks) => (
          <a
            href={siteConfig.social.discussions}
            className="text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
          >
            {chunks}
          </a>
        ),
        email: (chunks) => (
          <a
            href={`mailto:${siteConfig.email}`}
            className="text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
          >
            {chunks}
          </a>
        ),
      })}
    </p>
  );
}
