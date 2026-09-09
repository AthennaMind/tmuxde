import type { MetadataRoute } from "next";

/**
 * Nothing here belongs in a search index.
 *
 * Every route is either a terminal behind a pairing credential, a thin auth
 * form, or an account page — none of which are useful to a searcher, and all of
 * which compete with mtmux.com for the brand term. The app also ships from two
 * places (the hosted origin and every self-hoster's own machine), so leaving it
 * crawlable invites duplicate listings of the same eleven pages.
 *
 * The same statement is repeated as a `robots` meta tag in `layout.tsx`, for
 * crawlers that fetch a page without first fetching this file.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
