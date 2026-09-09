import { getTranslations } from "next-intl/server";

import { Section, SectionHeading } from "@/components/primitives/section";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";

type LandscapeRow = {
  id: string;
  tool: string;
  what: string;
  reach: string;
  readMore: string;
};

/**
 * Where each row's "read more" points.
 *
 * The hrefs live here rather than in `messages/` for two reasons: a URL is not
 * copy to be translated, and keeping them as literal strings in component
 * source is what lets `src/lib/link-graph.ts` see marketing → blog edges at
 * build time. A route assembled at runtime would be invisible to it.
 */
const ROW_HREF: Record<string, string> = {
  tmate: "/blog/tmate-alternative",
  ttyd: "/blog/ttyd-vs-wetty",
  wetty: "/blog/ttyd-vs-wetty",
  gotty: "/blog/tmux-in-browser",
  sshx: "/blog/tmux-in-browser",
  zellij: "/blog/tmux-commands",
  ssh: "/blog/tmux-from-phone",
  mtmux: "/docs",
};

/**
 * The wider landscape, as one table.
 *
 * The matrix above compares five options across eight capabilities, which is
 * the right shape for someone choosing. This is the other question — "what even
 * is sshx / gotty / zellij" — and it earns the long-tail comparisons without
 * spending a whole thin page on each name. Rows are tools here, not
 * capabilities, precisely so the table can grow sideways without adding a ninth
 * column nobody can read on a phone.
 */
export async function CompareLandscape() {
  const t = await getTranslations("compare.landscape");
  const rows = t.raw("rows") as LandscapeRow[];
  const columns = t.raw("columns") as string[];

  return (
    <Section bordered={false} innerClassName="pt-0">
      <SectionHeading
        level={2}
        size="sm"
        title={t("title")}
        description={t("description")}
        className="mb-8"
      />
      <div className="overflow-x-auto rounded-xl border border-line">
        <Table className="min-w-[720px]">
          <TableCaption className="sr-only">{t("caption")}</TableCaption>
          <TableHeader>
            <TableRow className="border-line-subtle hover:bg-transparent">
              {columns.map((column) => (
                <TableHead
                  key={column}
                  scope="col"
                  className="bg-surface-panel font-mono text-xs tracking-[0.1em] text-text-faint uppercase"
                >
                  {column}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                className="border-line-subtle hover:bg-surface-panel"
              >
                <TableHead
                  scope="row"
                  className="bg-transparent font-mono text-[0.9375rem] whitespace-nowrap text-text-strong"
                >
                  {row.tool}
                </TableHead>
                <TableCell className="text-[0.9375rem] whitespace-normal text-text-muted">
                  {row.what}
                </TableCell>
                <TableCell className="text-[0.9375rem] whitespace-normal text-text-muted">
                  {row.reach}
                </TableCell>
                <TableCell className="text-[0.9375rem] whitespace-normal">
                  <Link
                    href={ROW_HREF[row.id] ?? "/compare"}
                    className="text-brand underline decoration-brand/40 underline-offset-3 hover:decoration-brand"
                  >
                    {row.readMore}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="mt-6 max-w-[68ch] text-[0.9375rem] leading-[1.75] text-text-faint">
        {t("note")}
      </p>
    </Section>
  );
}
