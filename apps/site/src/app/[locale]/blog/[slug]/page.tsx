import type { Metadata } from "next";
import {
  getFormatter,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { notFound } from "next/navigation";

import { AuthorCard } from "@/components/blog/author-card";
import { PostCard, TagChip } from "@/components/blog/post-card";
import { PostCover } from "@/components/blog/post-cover";
import { TableOfContents } from "@/components/blog/table-of-contents";
import { JsonLd } from "@/components/json-ld";
import { CopyInstall } from "@/components/site/copy-install";
import { getAuthor } from "@/config/authors";
import { siteConfig } from "@/config/site";
import { locales, type Locale } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";
import { getAllSlugs, getPost, getRelatedPosts } from "@/lib/blog";
import { extractFaqEntries, extractStepEntries, renderMdx } from "@/lib/mdx";
import { absoluteUrl, buildMetadata } from "@/lib/seo";
import {
  blogPostingSchema,
  breadcrumbSchema,
  faqSchema,
  graph,
  howToSchema,
} from "@/lib/structured-data";

export async function generateStaticParams() {
  const params: Array<{ locale: string; slug: string }> = [];
  for (const locale of locales) {
    for (const slug of await getAllSlugs(locale.code)) {
      params.push({ locale: locale.code, slug });
    }
  }
  return params;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const post = await getPost(locale, slug);
  if (!post) return {};

  const { frontmatter } = post;
  const author = getAuthor(frontmatter.author);

  return buildMetadata({
    locale: locale as Locale,
    path: `/blog/${slug}`,
    title: frontmatter.title,
    description: frontmatter.description,
    keywords: frontmatter.keywords,
    type: "article",
    publishedTime: frontmatter.date,
    modifiedTime: frontmatter.updated ?? frontmatter.date,
    authors: [author.name],
    section: frontmatter.category,
    tags: frontmatter.tags,
  });
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const post = await getPost(locale, slug);
  if (!post) notFound();

  const t = await getTranslations("blog");
  const format = await getFormatter();
  const author = getAuthor(post.frontmatter.author);
  const [content, related] = await Promise.all([
    renderMdx(post.body),
    getRelatedPosts(locale, slug),
  ]);
  const faqEntries = extractFaqEntries(post.body);
  // A `HowTo` is only honest when the page renders the procedure it describes,
  // so both come from the same source: no `<Steps>`, no `HowTo`.
  const stepEntries = post.frontmatter.howTo
    ? extractStepEntries(post.body)
    : [];

  return (
    <>
      <JsonLd
        json={graph(
          breadcrumbSchema(locale as Locale, [
            { name: t("breadcrumb.home"), href: "/" },
            { name: t("breadcrumb.blog"), href: "/blog" },
            { name: post.frontmatter.title, href: `/blog/${slug}` },
          ]),
          blogPostingSchema({
            locale: locale as Locale,
            path: `/blog/${slug}`,
            title: post.frontmatter.title,
            description: post.frontmatter.description,
            datePublished: post.frontmatter.date,
            dateModified: post.frontmatter.updated ?? post.frontmatter.date,
            author,
            image: `${absoluteUrl(locale as Locale, `/blog/${slug}`)}/opengraph-image`,
            keywords: post.frontmatter.keywords,
            wordCount: post.wordCount,
            section: post.frontmatter.category,
            about: post.frontmatter.keywords[0],
            mentions: post.frontmatter.tags,
          }),
          ...(faqEntries.length > 0 ? [faqSchema(faqEntries)] : []),
          ...(stepEntries.length > 1
            ? [
                howToSchema({
                  name: post.frontmatter.title,
                  description: post.frontmatter.description,
                  steps: stepEntries,
                }),
              ]
            : []),
        )}
      />

      <div className="container-content grid gap-10 py-(--spacing-section) lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-14">
        <article className="min-w-0">
          <nav aria-label={t("breadcrumb.label")} className="mb-6">
            <Link
              href="/blog"
              className="font-mono text-[0.875rem] text-text-subtle transition-colors hover:text-brand"
            >
              ← {t("backToBlog")}
            </Link>
          </nav>

          <header className="mb-9">
            <PostCover
              category={post.frontmatter.category}
              icon={post.frontmatter.icon}
              slug={slug}
              size="banner"
              className="mb-7"
            />

            <p className="eyebrow mb-3 text-brand">
              {t(`categories.${post.frontmatter.category}`)}
            </p>
            <h1 className="text-[clamp(1.8125rem,3.8vw,2.75rem)] leading-[1.04]">
              {post.frontmatter.title}
            </h1>
            <p className="mt-4 text-[1.1875rem] leading-[1.7] text-text-muted">
              {post.frontmatter.description}
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-subtle pt-5 font-mono text-[0.875rem] text-text-faint">
              <span className="text-text-muted">{author.name}</span>
              <span aria-hidden="true">·</span>
              <time dateTime={post.frontmatter.date}>
                {format.dateTime(new Date(post.frontmatter.date), "long")}
              </time>
              {post.frontmatter.updated ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t("updatedOn", {
                      date: format.dateTime(
                        new Date(post.frontmatter.updated),
                        "short",
                      ),
                    })}
                  </span>
                </>
              ) : null}
              <span aria-hidden="true">·</span>
              <span>
                {t("readingTime", { minutes: post.readingTimeMinutes })}
              </span>
            </div>

            {post.untranslated ? (
              <p className="mt-5 rounded-lg border border-line border-s-2 border-s-signal-stalled bg-surface-raised p-4 text-[1rem] text-text-muted">
                {t("untranslated")}
              </p>
            ) : null}
          </header>

          <div className="prose-mtmux prose max-w-none">{content}</div>

          <div className="mt-10 flex flex-wrap gap-2 border-t border-line-subtle pt-6">
            {post.frontmatter.tags.map((tag) => (
              <TagChip key={tag} tag={tag} />
            ))}
          </div>

          <AuthorCard author={author} />

          <div className="mt-8 flex flex-col items-center gap-4 rounded-xl border border-line bg-surface-raised px-6 py-9 text-center">
            <p className="max-w-[44ch] text-[1.125rem] leading-[1.7] text-text-muted">
              {t("postCta", { name: siteConfig.name })}
            </p>
            <CopyInstall size="lg" />
          </div>
        </article>

        <aside className="hidden lg:block">
          <div className="sticky top-24">
            <TableOfContents entries={post.toc} />
          </div>
        </aside>
      </div>

      {related.length > 0 ? (
        <section className="border-t border-line-subtle bg-surface-raised">
          <div className="container-content py-(--spacing-section)">
            <h2 className="mb-6 text-[clamp(1.375rem,2.4vw,1.75rem)]">
              {t("related")}
            </h2>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {related.map((item) => (
                <PostCard key={item.slug} post={item} />
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
