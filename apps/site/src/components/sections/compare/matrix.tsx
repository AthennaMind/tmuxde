import { getTranslations } from "next-intl/server";

import { Section } from "@/components/primitives/section";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type CellKind = "yes" | "no" | "text" | "good" | "warn";

type MatrixCellData = {
  kind: CellKind;
  text?: string;
};

type MatrixRow = {
  label: string;
  cells: MatrixCellData[];
};

const CELL_TONE: Record<CellKind, string> = {
  yes: "text-brand",
  no: "text-text-faint",
  text: "text-text-muted",
  good: "text-brand",
  warn: "text-signal-blocked",
};

function MatrixCell({
  cell,
  yesLabel,
  noLabel,
}: {
  cell: MatrixCellData;
  yesLabel: string;
  noLabel: string;
}) {
  if (cell.kind === "yes") {
    return (
      <TableCell
        className={cn("whitespace-nowrap font-mono text-sm", CELL_TONE.yes)}
      >
        <span aria-hidden="true">
          {"✓"}
          {cell.text ? ` ${cell.text}` : ""}
        </span>
        <span className="sr-only">
          {cell.text ? `${yesLabel}, ${cell.text}` : yesLabel}
        </span>
      </TableCell>
    );
  }

  if (cell.kind === "no") {
    return (
      <TableCell
        className={cn("whitespace-nowrap font-mono text-sm", CELL_TONE.no)}
      >
        <span aria-hidden="true">{"—"}</span>
        <span className="sr-only">{noLabel}</span>
      </TableCell>
    );
  }

  return (
    <TableCell
      className={cn(
        "whitespace-nowrap font-mono text-sm",
        CELL_TONE[cell.kind],
      )}
    >
      {cell.text}
    </TableCell>
  );
}

/**
 * The comparison matrix. A real semantic table — not a card grid — because
 * answer engines extract tables far more reliably than prose, and this is
 * the exact row-per-capability lookup someone searching "tmate vs mtmux"
 * wants.
 */
export async function CompareMatrix() {
  const t = await getTranslations("compare.matrix");
  const columns = t.raw("columns") as string[];
  const rows = t.raw("rows") as MatrixRow[];
  const yesLabel = t("yesLabel");
  const noLabel = t("noLabel");

  return (
    <Section bordered={false} innerClassName="pt-0">
      <h2 className="sr-only">{t("srTitle")}</h2>
      <div className="overflow-x-auto rounded-xl border border-line">
        <Table className="min-w-[760px]">
          <TableCaption className="sr-only">{t("caption")}</TableCaption>
          <TableHeader>
            <TableRow className="border-line-subtle hover:bg-transparent">
              <TableHead
                scope="col"
                className="bg-surface-panel font-mono text-xs tracking-[0.1em] text-text-faint uppercase"
              >
                <span className="sr-only">{t("rowHeaderLabel")}</span>
              </TableHead>
              {columns.map((column, index) => (
                <TableHead
                  key={column}
                  scope="col"
                  className={cn(
                    "bg-surface-panel font-mono text-xs tracking-[0.1em] uppercase",
                    index === 0 ? "text-brand" : "text-text-faint",
                  )}
                >
                  {column}
                </TableHead>
              ))}
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
                {row.cells.map((cell, index) => (
                  <MatrixCell
                    key={`${row.label}-${index}`}
                    cell={cell}
                    yesLabel={yesLabel}
                    noLabel={noLabel}
                  />
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {/* The notification row is all dashes including our own column. Saying
          why, directly under the table, is what stops it reading as an
          oversight. */}
      <p className="mt-6 max-w-[68ch] text-[0.9375rem] leading-[1.75] text-text-faint">
        {t("note")}
      </p>
    </Section>
  );
}
