"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Layers } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { PanelIcon } from "@/components/dashboard/panel-icon";
import { campaignsToCsv, csvFileName, DEMO_ORIGIN } from "@/modules/traffic/csv";
import { formatCount, formatMoney } from "@/modules/traffic/format";
import {
  DEFAULT_SORT,
  sortRows,
  STATUS_LABEL,
  TEXT_SORT_KEYS,
  type CampaignRow,
  type CampaignStatus,
  type SortKey,
  type SortState,
  type TrafficReport,
} from "@/modules/traffic/report";
import { PLATFORM_LABEL, type DateRange, type Platform } from "@/modules/traffic/schema";
import { PlatformMark } from "./platform-mark";

const COLUMN_LABEL: Record<SortKey, string> = {
  name: "Campanha",
  platform: "Plataforma",
  legalArea: "Área de atuação",
  investmentCents: "Investimento",
  conversations: "Conversas",
  qualifiedLeads: "Leads qualificados",
  contracts: "Contratos",
  cplCents: "CPL",
  status: "Situação",
};

/** Colunas que, em largura média, passam para baixo do nome da campanha. */
const WIDE_ONLY: readonly SortKey[] = ["platform", "legalArea", "status"];
const COLUMNS: readonly SortKey[] = [
  "name",
  "platform",
  "legalArea",
  "investmentCents",
  "conversations",
  "qualifiedLeads",
  "contracts",
  "cplCents",
  "status",
];
const NUMERIC: readonly SortKey[] = ["investmentCents", "conversations", "qualifiedLeads", "contracts", "cplCents"];

const STATUS_STYLE: Record<CampaignStatus, string> = {
  ativa: "bg-success-bg text-success",
  pausada: "bg-warning-bg text-warning",
  encerrada: "bg-neutral-bg text-neutral",
};

function StatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-meta font-semibold", STATUS_STYLE[status])}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {STATUS_LABEL[status]}
    </span>
  );
}

function AreaTag({ area }: { area: string | null }) {
  return area ? (
    <span className="inline-block rounded-input border border-border-strong bg-neutral-bg px-1.5 py-px text-meta text-text-secondary">{area}</span>
  ) : (
    <span className="text-meta text-text-muted">Não informada</span>
  );
}

function PlatformName({ platform }: { platform: Platform }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <PlatformMark platform={platform} />
      {PLATFORM_LABEL[platform]}
    </span>
  );
}

const cplText = (cents: number | null) => (cents === null ? "—" : formatMoney(cents));

function cellValue(row: CampaignRow | TrafficReport["totals"], key: SortKey): string {
  switch (key) {
    case "investmentCents":
      return formatMoney(row.investmentCents);
    case "conversations":
      return formatCount(row.conversations);
    case "qualifiedLeads":
      return formatCount(row.qualifiedLeads);
    case "contracts":
      return formatCount(row.contracts);
    case "cplCents":
      return cplText(row.cplCents);
    default:
      return "";
  }
}

/** Texto começa em ordem alfabética; número começa do maior para o menor. */
const firstDirection = (key: SortKey): SortState["direction"] => (TEXT_SORT_KEYS.includes(key) ? "asc" : "desc");

function SortHeader({ column, sort, onSort }: { column: SortKey; sort: SortState; onSort: (key: SortKey) => void }) {
  const active = sort.key === column;
  const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  const numeric = NUMERIC.includes(column);
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
      className={cn(
        "px-2 py-2 align-bottom text-meta font-semibold text-text-secondary first:pl-4 last:pr-4",
        numeric ? "text-right" : "text-left",
        WIDE_ONLY.includes(column) && "hidden @min-[1040px]:table-cell",
      )}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm text-meta font-semibold hover:text-text",
          numeric ? "flex-row-reverse text-right" : "text-left",
          active ? "text-text" : "text-text-secondary",
        )}
      >
        <span>{COLUMN_LABEL[column]}</span>
        <Icon size={12} strokeWidth={1.9} aria-hidden className={cn("shrink-0", !active && "opacity-60")} />
      </button>
    </th>
  );
}

function download(fileName: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Depois do clique: revogar na hora pode cancelar o download em alguns navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Campanhas do conjunto filtrado. Três apresentações conforme a largura do CONTEÚDO (não da janela, porque a
 * barra lateral ocupa parte dela): tabela completa; tabela com plataforma, área e situação sob o nome; e
 * cartões. Nas duas últimas, o seletor "Ordenar por" alcança as colunas que não têm cabeçalho próprio.
 */
export function CampaignsTable({
  rows,
  totals,
  period,
  platforms,
}: {
  rows: CampaignRow[];
  totals: TrafficReport["totals"];
  period: DateRange;
  platforms: Platform[];
}) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [exported, setExported] = useState("");
  const sorted = sortRows(rows, sort);
  const countLabel = `${rows.length} ${rows.length === 1 ? "campanha" : "campanhas"}`;

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, direction: s.direction === "asc" ? "desc" : "asc" } : { key, direction: firstDirection(key) }));

  function exportCsv() {
    download(csvFileName(period, platforms), campaignsToCsv(sorted, period, DEMO_ORIGIN));
    setExported(`Relatório gerado com ${countLabel}.`);
  }

  return (
    <section aria-labelledby="campanhas-titulo" className="@container min-w-0 rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <PanelIcon icon={Layers} />
          <div className="flex min-w-0 flex-col">
            <h2 id="campanhas-titulo" className="m-0 text-lead font-bold text-text">
              Campanhas
            </h2>
            <p className="m-0 text-meta text-text-muted">Desempenho no período e nas plataformas selecionadas. A situação é a atual.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-2 @min-[1040px]:hidden">
            <label className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-small text-text-secondary">
              Ordenar por
              <select
                value={sort.key}
                onChange={(e) => {
                  const key = e.target.value as SortKey;
                  setSort({ key, direction: firstDirection(key) });
                }}
                className="cursor-pointer rounded-input border-0 bg-surface text-small font-semibold text-text"
              >
                {COLUMNS.map((c) => (
                  <option key={c} value={c}>
                    {COLUMN_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="secondary" size="sm" onClick={() => toggle(sort.key)}>
              {sort.direction === "asc" ? <ArrowUp size={13} aria-hidden /> : <ArrowDown size={13} aria-hidden />}
              {sort.direction === "asc" ? "Crescente" : "Decrescente"}
            </Button>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={exportCsv} className="border-accent-border text-accent">
            <Download size={13} aria-hidden />
            Exportar CSV
          </Button>
        </div>
      </div>
      <p role="status" className="sr-only">
        {exported}
      </p>

      {/* Largura média e grande: tabela. */}
      <div className="hidden @min-[660px]:block">
        <table className="w-full border-collapse text-small">
          <caption className="sr-only">Campanhas do período, com totais</caption>
          <thead className="border-y border-border-subtle bg-surface-subtle">
            <tr>
              {COLUMNS.map((c) => (
                <SortHeader key={c} column={c} sort={sort} onSort={toggle} />
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.id} className="border-b border-border-subtle">
                <th scope="row" className="px-2 py-2.5 pl-4 text-left font-medium text-text">
                  <span className="block">{row.name}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 font-normal text-text-secondary @min-[1040px]:hidden">
                    <PlatformName platform={row.platform} />
                    <AreaTag area={row.legalArea} />
                    <StatusBadge status={row.status} />
                  </span>
                </th>
                {COLUMNS.slice(1).map((c) => (
                  <td
                    key={c}
                    className={cn(
                      "px-2 py-2.5 text-text-secondary last:pr-4",
                      NUMERIC.includes(c) ? "tabular text-right whitespace-nowrap text-text" : "text-left",
                      WIDE_ONLY.includes(c) && "hidden @min-[1040px]:table-cell",
                    )}
                  >
                    {c === "platform" ? (
                      <PlatformName platform={row.platform} />
                    ) : c === "legalArea" ? (
                      <AreaTag area={row.legalArea} />
                    ) : c === "status" ? (
                      <StatusBadge status={row.status} />
                    ) : (
                      cellValue(row, c)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr data-testid="traffic-totals-row">
              <th scope="row" className="px-2 py-3 pl-4 text-left font-bold text-accent">
                Total ({countLabel})
              </th>
              <td className="hidden @min-[1040px]:table-cell" />
              <td className="hidden @min-[1040px]:table-cell" />
              {NUMERIC.map((c) => (
                <td key={c} data-testid={`traffic-total-${c}`} className="tabular px-2 py-3 text-right font-bold whitespace-nowrap text-accent last:pr-4">
                  {cellValue(totals, c)}
                </td>
              ))}
              <td className="hidden @min-[1040px]:table-cell" />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Largura estreita: um cartão por campanha. */}
      <div className="@min-[660px]:hidden">
        <ul className="m-0 flex list-none flex-col p-0">
          {sorted.map((row) => (
            <li key={row.id} className="flex flex-col gap-2 border-t border-border-subtle px-4 py-3">
              <p className="m-0 text-body font-semibold text-text">{row.name}</p>
              <div className="flex flex-wrap items-center gap-1.5 text-small text-text-secondary">
                <PlatformName platform={row.platform} />
                <AreaTag area={row.legalArea} />
                <StatusBadge status={row.status} />
              </div>
              <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1.5">
                {NUMERIC.map((c) => (
                  <div key={c} className="min-w-0">
                    <dt className="text-meta text-text-muted">{COLUMN_LABEL[c]}</dt>
                    <dd className="tabular m-0 text-small font-semibold text-text">{cellValue(row, c)}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
        <div className="border-t border-border px-4 py-3">
          <p className="m-0 mb-1.5 text-body font-bold text-accent">Total ({countLabel})</p>
          <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1.5">
            {NUMERIC.map((c) => (
              <div key={c} className="min-w-0">
                <dt className="text-meta text-text-muted">{COLUMN_LABEL[c]}</dt>
                <dd className="tabular m-0 text-small font-bold text-accent">{cellValue(totals, c)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <p className="m-0 border-t border-border-subtle px-4 py-2.5 text-meta text-text-muted">
        CPL (custo por lead qualificado) = investimento ÷ leads qualificados do mesmo filtro. “—” quando não há lead qualificado. O CPL do
        total usa as somas, não a média das campanhas.
      </p>
    </section>
  );
}
