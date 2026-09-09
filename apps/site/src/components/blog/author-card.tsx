import { getTranslations } from "next-intl/server";

import type { Author } from "@/config/authors";

export async function AuthorCard({ author }: { author: Author }) {
  const t = await getTranslations("blog");

  return (
    <aside className="mt-12 flex gap-4 rounded-xl border border-line bg-surface-raised p-5">
      <span
        aria-hidden="true"
        className="grid size-11 shrink-0 place-items-center rounded-full bg-brand font-mono text-[1rem] font-600 text-brand-contrast"
      >
        {author.initials}
      </span>
      <div className="min-w-0">
        <p className="text-[1rem] font-600 text-text-strong">
          {author.name}
        </p>
        <p className="font-mono text-[0.875rem] text-text-faint">
          {author.role}
        </p>
        <p className="mt-2 text-[1rem] leading-[1.7] text-text-muted">
          {author.bio}
        </p>
        {author.github ? (
          <a
            href={author.github}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-block font-mono text-[0.875rem] text-brand hover:underline"
          >
            {t("authorGithub")}
          </a>
        ) : null}
      </div>
    </aside>
  );
}
