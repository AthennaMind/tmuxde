import { createFromSource } from "fumadocs-core/search/server";

import { source } from "@/lib/source";

/**
 * The endpoint the Fumadocs search dialog calls.
 *
 * `RootProvider` mounts the default search dialog, which fetches
 * `/api/search?query=…`. There was no `src/app/api` directory at all, so every
 * keystroke in the search box hit a 404 and the dialog rendered "No results"
 * for every query on every page — search has never worked on this site.
 *
 * `createFromSource` builds the index from `loader.getPages()`, reading the
 * `structuredData` that `fumadocs-mdx` already emits for each document. There
 * is nothing to keep in sync: a new MDX file is indexed by existing.
 */
export const { GET } = createFromSource(source);
