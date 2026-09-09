import defaultMdxComponents from "fumadocs-ui/mdx";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { Callout } from "fumadocs-ui/components/callout";
import { Card, Cards } from "fumadocs-ui/components/card";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";

/**
 * The component map every MDX page is rendered with.
 *
 * Until this existed the page renderer passed no `components` prop at all, so
 * MDX resolved `<Callout>` and friends against nothing — an undefined component
 * is a render error, which is why not one of the 22 pages used a single
 * Fumadocs primitive and every caveat was a blockquote. `defaultMdxComponents`
 * also supplies the anchored headings, the code-block frame and the
 * `next/link`-backed `a`, so plain Markdown gets better without any page
 * changing.
 *
 * Adoption is deliberately selective: `<Steps>` where the order is load-bearing,
 * `<Callout>` where getting it wrong has a security consequence, `<Cards>` on
 * the section hubs. A page whose prose is already a reference table gains
 * nothing from being wrapped in chrome.
 */
const components = {
  ...defaultMdxComponents,
  Accordion,
  Accordions,
  Callout,
  Card,
  Cards,
  File,
  Files,
  Folder,
  Step,
  Steps,
  Tab,
  Tabs,
  TypeTable,
} as const;

export type MdxComponentMap = typeof components & Record<string, unknown>;

export function getMDXComponents(
  overrides?: Record<string, unknown>,
): MdxComponentMap {
  return { ...components, ...overrides } as MdxComponentMap;
}

/**
 * Next's `mdx-components` convention, for any `.mdx` file compiled as a route
 * rather than through the Fumadocs loader. Today there are none, but exporting
 * it costs a line and means adding one does not silently render unstyled.
 */
export const useMDXComponents = getMDXComponents;
