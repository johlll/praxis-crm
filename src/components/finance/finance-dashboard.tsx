"use client";

import { useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, FlaskConical, RotateCcw } from "lucide-react";

import { addMonths, monthLabel, monthName, monthOf } from "@/lib/civil-date";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/modules/finance/format";
import { buildMonthView, movementDate, selectableMonths, type FinanceEntry } from "@/modules/finance/ledger";
import { CashFlowChart } from "./cash-flow-chart";
import { EntriesTable } from "./entries-table";
import { FinanceCards } from "./finance-cards";
import { NewEntryDialog, SIMULATION_NOTICE } from "./new-entry-dialog";
import { ReceivablesDonut } from "./receivables-donut";

const arrowClass =
  "flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-text-secondary hover:bg-surface-hover hover:text-text disabled:cursor-default disabled:opacity-40";

/**
 * Financeiro da DEMONSTRAÇÃO. Os lançamentos (iniciais e simulados) e o mês escolhido vivem só na memória
 * desta tela: nada vai para banco, URL, localStorage ou sessionStorage. Recarregar volta ao estado inicial.
 */
export function FinanceDashboard({
  initialEntries,
  coverageStart,
  today,
}: {
  initialEntries: FinanceEntry[];
  coverageStart: string;
  today: string;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [month, setMonth] = useState(monthOf(today));
  const [added, setAdded] = useState<FinanceEntry | null>(null);
  const counter = useRef(0);

  const view = buildMonthView(entries, month, today, coverageStart);
  const months = selectableMonths(entries, today);
  const index = months.indexOf(month);
  const simulatedCount = entries.filter((e) => e.simulated).length;
  const addedMonth = added ? monthOf(movementDate(added)) : null;

  function add(entry: FinanceEntry) {
    setEntries((current) => [...current, entry]);
    setAdded(entry);
  }

  function restore() {
    setEntries(initialEntries);
    setAdded(null);
    setMonth(monthOf(today));
  }

  return (
    <>
      <div role="note" className="flex items-start gap-2 rounded-md border border-purple/30 bg-purple-bg px-3 py-2 text-small text-purple">
        <FlaskConical size={14} aria-hidden className="mt-0.5 shrink-0" />
        <p className="m-0">
          <strong>Dados demonstrativos.</strong> Nomes e valores fictícios. {SIMULATION_NOTICE}: o que você lançar some ao
          recarregar a página.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Mês exibido" className="flex items-center gap-1.5">
          <button type="button" className={arrowClass} aria-label="Mês anterior" disabled={index <= 0} onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft size={16} aria-hidden />
          </button>
          <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-3">
            <CalendarDays size={14} aria-hidden className="shrink-0 text-text-secondary" />
            <span className="sr-only">Mês e ano</span>
            <select value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 min-w-0 cursor-pointer rounded-input border-0 bg-surface text-body font-semibold text-text">
              {months.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={arrowClass} aria-label="Próximo mês" disabled={index >= months.length - 1} onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight size={16} aria-hidden />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {simulatedCount > 0 ? (
            <Button type="button" variant="secondary" onClick={restore}>
              <RotateCcw size={14} aria-hidden />
              Restaurar demonstração
            </Button>
          ) : null}
          <NewEntryDialog today={today} nextId={() => `sim-${(counter.current += 1)}`} onAdd={add} />
        </div>
      </div>

      {/* A região existe sempre, para o leitor de tela anunciar quando o texto chega. */}
      <div role="status" className="empty:hidden">
        {added && addedMonth ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-purple/30 bg-surface px-3 py-2 text-small text-text-secondary">
            <p className="m-0">
              <strong className="text-text">Incluído na simulação</strong> (não gravado): “{added.description}”, em{" "}
              {monthName(addedMonth)} de {addedMonth.slice(0, 4)}.
            </p>
            {addedMonth !== month ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => setMonth(addedMonth)}>
                Ver {monthName(addedMonth)}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {view.beforeCoverage ? (
        <p className="m-0 text-meta text-warning">
          Os dados da demonstração começam em {formatDate(coverageStart)}. Antes disso só aparece o que for lançado na simulação.
        </p>
      ) : null}

      <FinanceCards view={view} />

      <div className="grid grid-cols-1 gap-4 @min-[880px]:grid-cols-[minmax(0,2.55fr)_minmax(0,1fr)]">
        <CashFlowChart view={view} />
        <ReceivablesDonut view={view} />
      </div>

      {/* A chave reinicia busca e "mostrar todos" ao trocar de mês. */}
      <EntriesTable key={month} rows={view.rows} month={month} today={today} />
    </>
  );
}
