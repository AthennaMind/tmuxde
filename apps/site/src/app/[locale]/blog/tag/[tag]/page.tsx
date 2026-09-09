import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { PostCard, TagChip } from "@/components/blog/post-card";
import { JsonLd } from "@/components/json-ld";
import { Eyebrow } from "@/components/primitives/section";
import { locales, type Locale } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";
import {
  getAllTags,
  getPostsByTag,
  TAG_INDEX_MIN_POSTS,
  tagSlug,
} from "@/lib/blog";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, graph, itemListSchema } from "@/lib/structured-data";

export async function generateStaticParams() {
  const params: Array<{ locale: string; tag: string }> = [];
  for (const locale of locales) {
    for (const { tag } of await getAllTags(locale.code)) {
      params.push({ locale: locale.code, tag: tagSlug(tag) });
    }
  }
  return params;
}

/** Recovers the human-readable tag, and how many posts carry it, from its URL slug. */
async function resolveTag(
  locale: string,
  slug: string,
): Promise<{ tag: string; count: number } | null> {
  const tags = await getAllTags(locale);
  return tags.find(({ tag }) => tagSlug(tag) === slug) ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; tag: string }>;
}): Promise<Metadata> {
  const { locale, tag } = await params;
  const entry = await resolveTag(locale, tag);
  if (!entry) return {};

  const t = await getTranslations({ locale, namespace: "blog" });

  return buildMetadata({
    locale: locale as Locale,
    path: `/blog/tag/${tag}`,
    title: t("tagMeta.title", { tag: entry.tag }),
    description: t("tagMeta.description", { tag: entry.tag }),
    // Still linked, still crawlable — just not offered for indexing while the
    // tag has too few posts to be a better answer than the posts themselves.
    noindex: entry.count < TAG_INDEX_MIN_POSTS,
  });
}

export default async function BlogTagPage({
  params,
}: {
  params: Promise<{ locale: string; tag: string }>;
}) {
  const { locale, tag } = await params;
  setRequestLocale(locale);

  const entry = await resolveTag(locale, tag);
  if (!entry) notFound();
  const label = entry.tag;

  const t = await getTranslations("blog");
  const [posts, tags] = await Promise.all([
    getPostsByTag(locale, label),
    getAllTags(locale),
  ]);

  return (
    <>
      <JsonLd
        json={graph(
          breadcrumbSchema(locale as Locale, [
            { name: t("breadcrumb.home"), href: "/" },
            { name: t("breadcrumb.blog"), href: "/blog" },
            { name: label, href: `/blog/tag/${tag}` },
          ]),
          itemListSchema(
            locale as Locale,
            posts.map((post) => ({
              name: post.frontmatter.title,
              href: `/blog/${post.slug}`,
              description: post.frontmatter.description,
            })),
          ),
        )}
      />

      <header className="container-content pt-(--spacing-section) pb-10">
        <Eyebrow>{t("eyebrow")}</Eyebrow>
        <h1 className="text-[clamp(1.8125rem,3.6vw,2.625rem)] leading-[1.04]">
          {t("tagTitle", { tag: label })}
        </h1>
        <p className="mt-4 max-w-[54ch] text-[1.125rem] leading-[1.7] text-text-muted">
          {t("tagDescription", { tag: label, count: posts.length })}
        </p>

        <nav aria-label={t("tagsLabel")} className="mt-7 flex flex-wrap gap-2">
          {tags.map((entry) => (
            <TagChip
              key={entry.tag}
              tag={entry.tag}
              count={entry.count}
              active={tagSlug(entry.tag) === tag}
            />
          ))}
        </nav>
      </header>

      <div className="container-content pb-(--spacing-section)">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {posts.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>

        <p className="mt-10">
          <Link
            href="/blog"
            className="font-mono text-[0.9375rem] text-brand hover:underline"
          >
            ← {t("backToBlog")}
          </Link>
        </p>
      </div>
    </>
  );
}
