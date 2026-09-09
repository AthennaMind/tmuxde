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
import { PLANS } from "@/config/plans";
import { cn } from "@/lib/utils";

/**
 * A real semantic table — not a card grid — because answer engines extract
 * tables far more reliably than prose, and "how many devices do I get on
 * Free" is exactly the row-per-capability lookup someone is searching for.
 *
 * The numbers are computed from `@/config/plans`, not typed into
 * pricing.json, so the table cannot drift away from what the broker actually
 * enforces. Only the labels are translated.
 */
function ComparisonCell({
  value,
  included,
  notIncluded,
}: {
  value: string;
  included: string;
  notIncluded: string;
}) {
  if (value === "—") {
    return (
      <TableCell className="whitespace-nowrap font-mono text-sm text-text-faint">
        <span aria-hidden="true">{value}</span>
        <span className="sr-only">{notIncluded}</span>
      </TableCell>
    );
  }

  if (value === "✓") {
    return (
      <TableCell
        className={cn("whitespace-nowrap font-mono text-sm text-brand")}
      >
        <span aria-hidden="true">{value}</span>
        <span className="sr-only">{included}</span>
      </TableCell>
    );
  }

  return (
    <TableCell className="whitespace-nowrap font-mono text-sm text-text-muted">
      {value}
    </TableCell>
  );
}

export async function PricingComparisonTable() {
  const t = await getTranslations("pricing.comparison");

  const unlimited = t("values.unlimited");
  const count = (n: number | null) => (n === null ? unlimited : String(n));

  const rows: Array<{ label: string; free: string; pro: string }> = [
    {
      label: t("labels.servers"),
      free: count(PLANS.free.servers),
      pro: count(PLANS.pro.servers),
    },
    {
      label: t("labels.devices"),
      free: count(PLANS.free.devicesPerServer),
      pro: count(PLANS.pro.devicesPerServer),
    },
    {
      label: t("labels.relayed"),
      free: `${PLANS.free.monthlyGib} GB`,
      pro: `${PLANS.pro.monthlyGib} GB`,
    },
    {
      label: t("labels.localLan"),
      free: t("values.unmetered"),
      pro: t("values.unmetered"),
    },
    { label: t("labels.sessions"), free: unlimited, pro: unlimited },
    { label: t("labels.tunnel"), free: "✓", pro: "✓" },
    {
      label: t("labels.namedServers"),
      free: PLANS.free.namedServers ? "✓" : t("values.hostname"),
      pro: PLANS.pro.namedServers ? "✓" : t("values.hostname"),
    },
    { label: t("labels.selfHost"), free: "✓", pro: "✓" },
  ];

  return (
    <Section tone="raised">
      <SectionHeading title={t("title")} level={2} size="sm" />
      <div className="mt-8 overflow-x-auto rounded-xl border border-line sm:mt-10">
        <Table className="min-w-[480px]">
          <TableCaption className="sr-only">{t("title")}</TableCaption>
          <TableHeader>
            <TableRow className="border-line-subtle hover:bg-transparent">
              <TableHead
                scope="col"
                className="bg-surface-panel font-mono text-xs tracking-[0.1em] text-text-faint uppercase"
              >
                <span className="sr-only">{t("rowHeaderLabel")}</span>
              </TableHead>
              <TableHead
                scope="col"
                className="bg-surface-panel font-mono text-xs tracking-[0.1em] text-text-faint uppercase"
              >
                {t("headers.free")}
              </TableHead>
              <TableHead
                scope="col"
                className="bg-surface-panel font-mono text-xs tracking-[0.1em] text-brand uppercase"
              >
                {t("headers.pro")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.label}
                className="border-line-subtle hover:bg-surface-panel"
              >
                <TableHead
                  scope="row"
                  className="whitespace-nowrap bg-transparent font-sans text-[1rem] font-500 text-text-strong"
                >
                  {row.label}
                </TableHead>
                <ComparisonCell
                  value={row.free}
                  included={t("included")}
                  notIncluded={t("notIncluded")}
                />
                <ComparisonCell
                  value={row.pro}
                  included={t("included")}
                  notIncluded={t("notIncluded")}
                />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="mt-6 max-w-[64ch] text-[0.9375rem] leading-[1.75] text-text-faint">
        {t("note")}
      </p>
    </Section>
  );
}
