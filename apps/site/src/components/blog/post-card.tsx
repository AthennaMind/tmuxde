import { getFormatter, getTranslations } from "next-intl/server";

import { PostCover } from "@/components/blog/post-cover";

import { getAuthor } from "@/config/authors";
import { Link } from "@/i18n/navigation";
import { type Post, tagSlug } from "@/lib/blog";
import { cn } from "@/lib/utils";

export async function PostMeta({
  post,
  className,
}: {
  post: Post;
  className?: string;
}) {
  const t = await getTranslations("blog");
  const format = await getFormatter();
  const author = getAuthor(post.frontmatter.author);

  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[0.875rem] text-text-faint",
        className,
      )}
    >
      <span>{author.name}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={post.frontmatter.date}>
        {format.dateTime(new Date(post.frontmatter.date), "short")}
      </time>
      <span aria-hidden="true">·</span>
      <span>{t("readingTime", { minutes: post.readingTimeMinutes })}</span>
    </p>
  );
}

export async function PostCard({
  post,
  featured = false,
}: {
  post: Post;
  featured?: boolean;
}) {
  const t = await getTranslations("blog");

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-xl border border-line bg-surface-raised transition-colors hover:border-line-strong",
        // The featured card puts its cover alongside the copy rather than
        // above it, so one wide card does not become mostly artwork.
        featured
          ? "flex flex-col sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          : "flex flex-col",
      )}
    >
      <PostCover
        category={post.frontmatter.category}
        icon={post.frontmatter.icon}
        slug={post.slug}
        size={featured ? "lg" : "md"}
        className={featured ? "sm:border-e sm:border-b-0" : undefined}
      />

      <div className={cn("flex flex-1 flex-col p-5", featured && "sm:p-7")}>
        <p className="eyebrow mb-3 text-brand">
          {t(`categories.${post.frontmatter.category}`)}
        </p>

        <h3
          className={cn(
            "font-sans font-600 tracking-[-0.015em] text-text-strong",
            featured
              ? "text-[clamp(1.375rem,2.8vw,1.875rem)] leading-[1.15]"
              : "text-[1.125rem] leading-snug",
          )}
        >
          <Link
            href={`/blog/${post.slug}`}
            className="after:absolute after:inset-0"
          >
            {post.frontmatter.title}
          </Link>
        </h3>

        <p
          className={cn(
            "mt-2.5 text-text-muted",
            featured
              ? "text-[1.0625rem] leading-[1.7]"
              : "text-[1rem] leading-[1.65]",
          )}
        >
          {post.frontmatter.description}
        </p>

        <div className="mt-auto pt-5">
          <PostMeta post={post} />
        </div>
      </div>
    </article>
  );
}

export function TagChip({
  tag,
  count,
  active = false,
}: {
  tag: string;
  count?: number;
  active?: boolean;
}) {
  return (
    <Link
      href={`/blog/tag/${tagSlug(tag)}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[0.875rem] transition-colors",
        active
          ? "border-transparent bg-brand text-brand-contrast"
          : "border-line bg-surface-panel text-text-muted hover:border-line-strong hover:text-text-strong",
      )}
    >
      {tag}
      {typeof count === "number" ? (
        <span
          className={cn(active ? "text-brand-contrast/70" : "text-text-faint")}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
}
