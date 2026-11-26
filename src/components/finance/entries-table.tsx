"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ListChecks, Search } from "lucide-react";

import { cn } from "@/lib/cn";
import { monthName } from "@/lib/civil-date";
import { Button } from "@/components/ui/button";
import { PanelIcon } from "@/components/dashboard/panel-icon";
import { formatDate, formatMoney, formatShortDate } from "@/modules/finance/format";
import {
  movementDate,
  searchEntries,
  sortByDate,
  STATUS_LABEL,
  statusOf,
  type DateOrder,
  type EntryStatus,
  type FinanceEntry,
} from "@/modules/finance/ledger";

const PAGE = 8;

const STATUS_STYLE: Record<EntryStatus, string> = {
  recebido: "border-success/40 bg-success-bg text-success",
  pago: "border-primary-border bg-primary-tint text-primary",
  em_atraso: "border-warning/40 bg-warning-bg text-warning",
  a_vencer: "border-info/40 bg-info-bg text-info",
  a_pagar: "border-border-strong bg-neutral-bg text-neutral",
};

function StatusBadge({ status }: { status: EntryStatus }) {
  return (
    <span className={cn("inline-block rounded-pill border px-2.5 py-0.5 text-meta font-semibold whitespace-nowrap", STATUS_STYLE[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Description({ entry }: { entry: FinanceEntry }) {
  return (
    <>
      <span className="block break-words text-text">{entry.description}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-meta font-normal text-text-muted">
        {entry.kind === "receita" ? "Receita" : "Despesa"}
        {entry.paidDate === null ? " · data = vencimento" : ""}
        {entry.simulated ? (
          <span className="rounded-input border border-purple/40 bg-purple-bg px-1.5 text-label font-semibold tracking-[0.6px] text-purple uppercase">
            simulado
          </span>
        ) : null}
      </span>
    </>
  );
}

export function EntriesTable({ rows, month, today }: { rows: FinanceEntry[]; month: string; today: string }) {
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<DateOrder>("desc");
  const [expanded, setExpanded] = useState(false);

  const matched = sortByDate(searchEntries(rows, query), order);
  const visible = expanded || query.trim() !== "" ? matched : matched.slice(0, PAGE);
  const SortIcon = order === "asc" ? ArrowUp : ArrowDown;

  const emptyMessage =
    rows.length === 0 ? `Nenhum lançamento em ${monthName(month)}.` : `Nenhum lançamento encontrado para “${query.trim()}”.`;

  return (
    <section aria-labelledby="lancamentos-titulo" className="@container min-w-0 rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <PanelIcon icon={ListChecks} />
          <div className="flex min-w-0 flex-col">
            <h2 id="lancamentos-titulo" className="m-0 text-lead font-bold text-text">
              Últimos lançamentos
            </h2>
            <p className="m-0 text-meta text-text-muted">Do mês selecionado; a situação é a de hoje</p>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 @min-[560px]:w-auto">
          <label className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border bg-surface-subtle px-3 text-text-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary @min-[560px]:w-[260px] @min-[560px]:flex-none">
            <Search size={14} aria-hidden className="shrink-0" />
            <span className="sr-only">Buscar lançamento</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar lançamento…"
              className="min-w-0 flex-1 border-0 bg-transparent text-body text-text placeholder:text-text-muted focus-visible:outline-none"
            />
          </label>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="@min-[700px]:hidden"
            onClick={() => setOrder(order === "asc" ? "desc" : "asc")}
          >
            <SortIcon size={13} aria-hidden />
            {order === "asc" ? "Mais antigos primeiro" : "Mais recentes primeiro"}
          </Button>
        </div>
      </div>
      <p role="status" className="sr-only">
        {query.trim() ? `${matched.length} lançamento${matched.length === 1 ? "" : "s"} encontrado${matched.length === 1 ? "" : "s"}.` : ""}
      </p>

      {matched.length === 0 ? (
        <p className="m-0 border-t border-border-subtle px-4 py-8 text-center text-body text-text-secondary">{emptyMessage}</p>
      ) : (
        <>
          <div className="hidden @min-[700px]:block">
            <table className="w-full table-fixed border-collapse text-small">
              <caption className="sr-only">Lançamentos de {monthName(month)}</caption>
              <colgroup>
                <col className="w-[104px]" />
                <col />
                <col className="w-[24%]" />
                <col className="w-[118px]" />
                <col className="w-[128px]" />
              </colgroup>
              <thead className="border-y border-border-subtle bg-surface-subtle">
                <tr className="text-left text-label font-semibold tracking-[1px] text-text-secondary uppercase">
                  <th scope="col" aria-sort={order === "asc" ? "ascending" : "descending"} className="py-2 pr-2 pl-4">
                    <button
                      type="button"
                      onClick={() => setOrder(order === "asc" ? "desc" : "asc")}
                      className="inline-flex items-center gap-1 rounded-sm text-label font-semibold tracking-[1px] uppercase hover:text-text"
                    >
                      Data
                      <SortIcon size={12} strokeWidth={2} aria-hidden />
                    </button>
                  </th>
                  <th scope="col" className="px-2 py-2">Descrição</th>
                  <th scope="col" className="px-2 py-2">Cliente ou fornecedor</th>
                  <th scope="col" className="px-2 py-2">Situação</th>
                  <th scope="col" className="py-2 pr-4 pl-2 text-right">Valor</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => (
                  <tr key={entry.id} className="border-b border-border-subtle align-middle">
                    <td className="tabular py-2.5 pr-2 pl-4 text-text-secondary">
                      <time dateTime={movementDate(entry)} title={formatDate(movementDate(entry))}>
                        {formatShortDate(movementDate(entry))}
                      </time>
                    </td>
                    <th scope="row" className="px-2 py-2.5 text-left font-medium">
                      <Description entry={entry} />
                    </th>
                    <td className="px-2 py-2.5 break-words text-text-secondary">{entry.party}</td>
                    <td className="px-2 py-2.5">
                      <StatusBadge status={statusOf(entry, today)} />
                    </td>
                    <td className="tabular py-2.5 pr-4 pl-2 text-right font-bold break-words text-text">{formatMoney(entry.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="m-0 flex list-none flex-col p-0 @min-[700px]:hidden">
            {visible.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1.5 border-t border-border-subtle px-4 py-3 text-small">
                <p className="m-0 font-medium">
                  <Description entry={entry} />
                </p>
                <p className="m-0 break-words text-text-secondary">{entry.party}</p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="tabular text-text-muted">{formatDate(movementDate(entry))}</span>
                  <StatusBadge status={statusOf(entry, today)} />
                  <span className="tabular font-bold text-text">{formatMoney(entry.amountCents)}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {query.trim() === "" && matched.length > PAGE ? (
        <div className="border-t border-border-subtle px-4 py-2.5">
          <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Mostrar menos" : `Mostrar todos (${matched.length})`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
