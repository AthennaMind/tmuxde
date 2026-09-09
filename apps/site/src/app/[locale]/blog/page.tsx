import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { PostCard, TagChip } from "@/components/blog/post-card";
import { JsonLd } from "@/components/json-ld";
import { Eyebrow } from "@/components/primitives/section";
import { CopyInstall } from "@/components/site/copy-install";
import { type Locale } from "@/i18n/locales";
import { routing } from "@/i18n/routing";
import { getAllPosts, getAllTags, getFeaturedPost } from "@/lib/blog";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, graph, itemListSchema } from "@/lib/structured-data";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "blog" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/blog",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function BlogIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("blog");
  const [posts, tags, featured] = await Promise.all([
    getAllPosts(locale),
    getAllTags(locale),
    getFeaturedPost(locale),
  ]);

  const rest = posts.filter((post) => post.slug !== featured?.slug);

  return (
    <>
      <JsonLd
        json={graph(
          breadcrumbSchema(locale as Locale, [
            { name: t("breadcrumb.home"), href: "/" },
            { name: t("breadcrumb.blog"), href: "/blog" },
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
        <h1 className="max-w-[18ch] text-[clamp(1.9375rem,4.2vw,3rem)] leading-[1]">
          {t("title")}
        </h1>
        <p className="mt-4 max-w-[56ch] text-[1.125rem] leading-[1.72] text-text-muted">
          {t("description")}
        </p>

        {tags.length > 0 ? (
          <nav
            aria-label={t("tagsLabel")}
            className="mt-7 flex flex-wrap gap-2"
          >
            {tags.map(({ tag, count }) => (
              <TagChip key={tag} tag={tag} count={count} />
            ))}
          </nav>
        ) : null}
      </header>

      <div className="container-content pb-(--spacing-section)">
        {posts.length === 0 ? (
          <p className="rounded-xl border border-line bg-surface-raised p-8 text-center text-text-muted">
            {t("empty")}
          </p>
        ) : (
          <>
            {/* The cards carry h3 titles, so each group needs an h2 above it to
                keep the heading outline contiguous. They are visually redundant
                next to the page heading, hence sr-only. */}
            {featured ? (
              <section aria-labelledby="featured-heading" className="mb-6">
                <h2 id="featured-heading" className="sr-only">
                  {t("featuredHeading")}
                </h2>
                <PostCard post={featured} featured />
              </section>
            ) : null}

            <section aria-labelledby="all-heading">
              <h2 id="all-heading" className="sr-only">
                {t("allHeading")}
              </h2>
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {rest.map((post) => (
                  <PostCard key={post.slug} post={post} />
                ))}
              </div>
            </section>
          </>
        )}

        <div className="mt-14 flex flex-col items-center gap-4 rounded-xl border border-line bg-surface-raised px-6 py-10 text-center">
          <p className="max-w-[42ch] text-[1.125rem] leading-[1.7] text-text-muted">
            {t("cta")}
          </p>
          <CopyInstall size="lg" />
        </div>
      </div>
    </>
  );
}
