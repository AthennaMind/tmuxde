import { getTranslations } from "next-intl/server";

import { CopyInstall } from "@/components/site/copy-install";
import { inlineLink } from "@/lib/rich-links";

export async function DocsInstall() {
  const t = await getTranslations("docs.install");

  return (
    <section id="install">
      <h2 className="mb-5 text-[clamp(1.3125rem,2.5vw,1.8125rem)] leading-[1.06]">
        {t("title")}
      </h2>
      <CopyInstall size="lg" />
      <p className="mt-4 max-w-[60ch] text-[0.9375rem] leading-[1.75] text-text-subtle">
        {t.rich("requirements", {
          post: inlineLink("/blog/install-tmux"),
        })}
      </p>
    </section>
  );
}
