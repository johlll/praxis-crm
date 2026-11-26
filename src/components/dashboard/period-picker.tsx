"use client";

import { useEffect, useId, useRef, useState, useTransition, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as Popover from "@radix-ui/react-dialog";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";

import { cn } from "@/lib/cn";
import { addCivilDays, addMonths, dayOfMonth, daysInMonth, monthLabel, monthOf } from "@/lib/civil-date";
import { Button } from "@/components/ui/button";
import {
  MAX_RANGE_DAYS,
  canPick,
  formatDayCount,
  formatDayLabel,
  formatLongDay,
  formatRangeLabel,
  isPending,
  monthGrid,
  pickDay,
  presetRange,
  rangeLength,
  weekdayOf,
  type DateRange,
  type Selection,
} from "@/modules/dashboard/period";
import { DASHBOARD_PERIODS, dashboardHref, type DashboardFilters, type DashboardPeriod } from "@/modules/dashboard/schema";
import { FILTER_TRIGGER_CLASS } from "./filter-trigger";

const WEEKDAYS = [
  ["dom", "domingo"],
  ["seg", "segunda-feira"],
  ["ter", "terça-feira"],
  ["qua", "quarta-feira"],
  ["qui", "quinta-feira"],
  ["sex", "sexta-feira"],
  ["sáb", "sábado"],
] as const;

const presetLabel = (days: number) => `Últimos ${days} dias`;

const arrowClass =
  "flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-text-secondary transition-colors hover:border-border-strong hover:bg-surface-hover hover:text-text active:bg-primary-tint aria-disabled:cursor-default aria-disabled:opacity-35 aria-disabled:hover:border-border aria-disabled:hover:bg-transparent";

/** O endereço de um atalho, mantendo os outros filtros. */
const presetHref = (filters: DashboardFilters, periodDays: DashboardPeriod) =>
  dashboardHref(filters, { periodDays, range: null, rangeError: null, selectedOpportunityId: null });

/**
 * Período da Visão geral: um botão com o período APLICADO e um painel com um único calendário.
 *
 * A escolha no calendário é um rascunho: só vale em "Aplicar período". Cancelar, Escape ou clicar fora
 * descartam o rascunho, e ao reabrir aparece o que está aplicado. O que está aplicado vem da URL (props),
 * então recarregar, voltar e avançar mantêm botão, calendário e números juntos.
 */
export function PeriodPicker({
  filters,
  today,
  notApplied = false,
}: {
  filters: DashboardFilters;
  /** Hoje no fuso do escritório, calculado no servidor. */
  today: string;
  /** O endereço pede um período que não está sendo mostrado (inválido ou indisponível). */
  notApplied?: boolean;
}) {
  const router = useRouter();
  const [navigating, startTransition] = useTransition();
  const applied: DateRange | null = notApplied ? null : (filters.range ?? presetRange(filters.periodDays, today));
  const appliedPreset = !notApplied && !filters.range ? filters.periodDays : null;
  const appliedKey = notApplied ? "nenhum" : filters.range ? `${filters.range.from}:${filters.range.to}` : `atalho:${filters.periodDays}`;
  const triggerLabel = appliedPreset ? presetLabel(appliedPreset) : applied ? formatRangeLabel(applied) : "Escolher período";

  // Aberto "para o período X": se a URL mudar (voltar/avançar), o painel fecha sozinho.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const open = openedFor === appliedKey;

  const [selection, setSelection] = useState<Selection>(null);
  /** A pessoa já clicou em algum dia desde que abriu. */
  const [touched, setTouched] = useState(false);
  const [month, setMonth] = useState(monthOf(today));
  const [cursor, setCursor] = useState(today);
  const [hover, setHover] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  /** O teclado pediu para o foco acompanhar o cursor depois de desenhar. */
  const followCursor = useRef(false);
  const titleId = useId();
  const guideId = useId();

  const focusDay = (day: string) => grid.current?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus();

  useEffect(() => {
    if (!followCursor.current) return;
    followCursor.current = false;
    focusDay(cursor);
  }, [cursor, month]);

  function setOpen(next: boolean) {
    if (!next) {
      setOpenedFor(null);
      return;
    }
    setSelection(applied);
    setTouched(false);
    setHover(null);
    setMonth(monthOf(applied?.to ?? today));
    setCursor(applied?.to ?? today);
    setOpenedFor(appliedKey);
  }

  function go(href: ReturnType<typeof dashboardHref>) {
    setOpenedFor(null);
    startTransition(() => router.push(href, { scroll: false }));
  }

  const pending = isPending(selection);
  const complete = selection && selection.to !== null ? { from: selection.from, to: selection.to } : null;

  function apply() {
    if (complete) go(dashboardHref(filters, { range: complete, rangeError: null, selectedOpportunityId: null }));
  }

  function choose(day: string) {
    setCursor(day);
    if (!canPick(selection, day, today)) return;
    setSelection(pickDay(selection, day, today));
    setTouched(true);
    setHover(null);
  }

  /** Muda o mês exibido levando junto o cursor do teclado (sempre há um dia alcançável na grade). */
  function showMonth(next: string) {
    if (next > monthOf(today)) return;
    const same = dayOfMonth(next, Number(cursor.slice(8, 10)));
    setMonth(next);
    setCursor(same > today ? today : same);
  }

  function onGridKey(event: KeyboardEvent<HTMLDivElement>) {
    const weekday = weekdayOf(cursor);
    const sameDayIn = (delta: number) => dayOfMonth(addMonths(monthOf(cursor), delta), Number(cursor.slice(8, 10)));
    const target =
      event.key === "ArrowLeft"
        ? addCivilDays(cursor, -1)
        : event.key === "ArrowRight"
          ? addCivilDays(cursor, 1)
          : event.key === "ArrowUp"
            ? addCivilDays(cursor, -7)
            : event.key === "ArrowDown"
              ? addCivilDays(cursor, 7)
              : event.key === "Home"
                ? addCivilDays(cursor, -weekday)
                : event.key === "End"
                  ? addCivilDays(cursor, 6 - weekday)
                  : event.key === "PageUp"
                    ? sameDayIn(-1)
                    : event.key === "PageDown"
                      ? sameDayIn(1)
                      : null;
    if (!target) return;
    event.preventDefault();
    const next = target > today ? today : target;
    followCursor.current = true;
    setCursor(next);
    setMonth(monthOf(next));
    setHover(next);
  }

  // Faixa desenhada: o intervalo escolhido ou, esperando o fim, a prévia até o dia apontado.
  const previewEnd = pending && hover && hover > selection!.from && canPick(selection, hover, today) ? hover : null;
  const bandFrom = selection?.from ?? null;
  const bandTo = complete?.to ?? previewEnd;
  const days = monthGrid(month);
  const lastOfMonth = dayOfMonth(month, daysInMonth(month));

  const guide = pending ? "Selecione a data final" : touched ? "Período selecionado" : "Selecione a data inicial";
  const summary = pending
    ? `Início: ${formatDayLabel(selection!.from)} · até ${MAX_RANGE_DAYS} dias`
    : complete
      ? `${touched ? "" : "Período atual: "}${formatRangeLabel(complete)} · ${formatDayCount(rangeLength(complete))}`
      : "Nenhuma data escolhida";

  return (
    <div className="relative">
      <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-busy={navigating || undefined}
            className={FILTER_TRIGGER_CLASS}
          >
            {navigating ? (
              <LoaderCircle size={14} aria-hidden className="shrink-0 animate-spin text-text-secondary" />
            ) : (
              <Calendar size={14} aria-hidden className="shrink-0 text-text-secondary" />
            )}
            <span className="sr-only">Período: </span>
            <span className="font-semibold whitespace-nowrap tabular">{triggerLabel}</span>
            <ChevronDown size={14} aria-hidden className="shrink-0 text-text-muted" />
          </button>
        </Popover.Trigger>

        <Popover.Content
          aria-describedby={guideId}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            focusDay(cursor);
          }}
          className="absolute top-[calc(100%+8px)] left-0 z-40 flex w-[352px] max-w-[calc(100vw-40px)] flex-col gap-3 rounded-[16px] border border-border bg-surface p-4 text-left shadow-raised outline-none"
        >
          <Popover.Title className="sr-only">Escolher o período</Popover.Title>
          <p className="sr-only">
            No calendário, as setas mudam de dia, Page Up e Page Down mudam de mês e Enter escolhe. Escape fecha sem aplicar.
          </p>

          <div role="group" aria-label="Atalhos de período" className="grid grid-cols-3 gap-1.5">
            {DASHBOARD_PERIODS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={appliedPreset === n}
                onClick={() => go(presetHref(filters, n))}
                className="h-9 rounded-md border border-border px-1 text-[11.5px] font-semibold whitespace-nowrap text-text-secondary transition-colors hover:border-border-strong hover:bg-surface-hover hover:text-text active:bg-primary-tint aria-pressed:border-primary-border aria-pressed:bg-primary-tint aria-pressed:text-primary"
              >
                {presetLabel(n)}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
            <button type="button" className={arrowClass} aria-label="Mês anterior" onClick={() => showMonth(addMonths(month, -1))}>
              <ChevronLeft size={16} aria-hidden />
            </button>
            <p id={titleId} aria-live="polite" className="m-0 text-lead font-bold text-text">
              {monthLabel(month)}
            </p>
            {/* aria-disabled (e não disabled): o foco não se perde ao chegar no mês atual. */}
            <button
              type="button"
              className={arrowClass}
              aria-label="Próximo mês"
              aria-disabled={month >= monthOf(today) || undefined}
              onClick={() => showMonth(addMonths(month, 1))}
            >
              <ChevronRight size={16} aria-hidden />
            </button>
          </div>

          <div ref={grid} role="grid" aria-labelledby={titleId} aria-multiselectable onKeyDown={onGridKey} onPointerLeave={() => setHover(null)}>
            <div role="row" className="grid grid-cols-7">
              {WEEKDAYS.map(([short, long]) => (
                <span
                  key={short}
                  role="columnheader"
                  aria-label={long}
                  className="pb-1.5 text-center text-label font-semibold tracking-[0.8px] text-text-muted uppercase"
                >
                  {short}
                </span>
              ))}
            </div>
            {Array.from({ length: 6 }, (_, week) => (
              <div key={week} role="row" className="grid grid-cols-7">
                {days.slice(week * 7, week * 7 + 7).map((day, column) => {
                  if (!day) return <span key={column} role="gridcell" className="h-11" />;
                  const isStart = day === bandFrom;
                  const isEnd = day === bandTo;
                  const inBand = bandFrom !== null && bandTo !== null && day >= bandFrom && day <= bandTo;
                  const chosen = isStart || day === complete?.to;
                  const selected = chosen || (complete !== null && day > complete.from && day < complete.to);
                  const enabled = canPick(selection, day, today);
                  // A faixa termina arredondada nas bordas da semana e do mês, inclusive entre linhas.
                  const leftEdge = column === 0 || day.endsWith("-01");
                  const rightEdge = column === 6 || day === lastOfMonth;
                  const showBand = inBand && bandFrom !== bandTo && !(isStart && rightEdge) && !(isEnd && leftEdge);
                  return (
                    <div key={day} role="gridcell" aria-selected={selected} className="relative flex h-11 items-center justify-center">
                      {showBand ? (
                        <span
                          aria-hidden
                          data-band={previewEnd ? "previa" : "escolhido"}
                          className={cn(
                            "absolute inset-y-[3px]",
                            previewEnd ? "bg-primary-tint" : "bg-primary-ring",
                            isStart ? "right-0 left-1/2" : isEnd ? "right-1/2 left-0" : "inset-x-0",
                            !isStart && !isEnd && leftEdge && "rounded-l-full",
                            !isStart && !isEnd && rightEdge && "rounded-r-full",
                          )}
                        />
                      ) : null}
                      <button
                        type="button"
                        data-day={day}
                        tabIndex={day === cursor ? 0 : -1}
                        aria-label={`${formatLongDay(day)}${day === today ? ", hoje" : ""}${
                          isStart ? ", início do período" : ""
                        }${day === complete?.to ? ", fim do período" : ""}`}
                        aria-current={day === today ? "date" : undefined}
                        aria-disabled={!enabled || undefined}
                        onClick={() => choose(day)}
                        onPointerEnter={() => setHover(day)}
                        onFocus={() => setCursor(day)}
                        className={cn(
                          "relative z-10 flex h-10 w-full max-w-10 items-center justify-center rounded-full text-body tabular transition-[background-color,color,transform] duration-100",
                          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text",
                          !enabled
                            ? "cursor-default text-text-disabled"
                            : chosen
                              ? "cursor-pointer bg-primary font-bold text-on-solid hover:bg-primary-hover active:scale-95"
                              : selected
                                ? "cursor-pointer font-semibold text-text hover:bg-primary-border active:scale-95"
                                : "cursor-pointer text-text hover:bg-surface-hover hover:ring-1 hover:ring-primary-border active:scale-95 active:bg-primary-tint",
                          previewEnd === day && "ring-1 ring-primary",
                        )}
                      >
                        {Number(day.slice(8, 10))}
                        {day === today ? (
                          <span aria-hidden className={cn("absolute bottom-1.5 size-1 rounded-full", chosen ? "bg-on-solid" : "bg-accent")} />
                        ) : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div id={guideId} role="status" className="flex min-h-[38px] flex-col justify-center border-t border-border-subtle pt-3">
            <span className="text-small font-semibold text-text">{guide}</span>
            <span className="text-meta text-text-tertiary tabular">{summary}</span>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" disabled={!complete} onClick={apply}>
              Aplicar período
            </Button>
          </div>
        </Popover.Content>
      </Popover.Root>

      {/* Sem JavaScript o calendário não abre: os atalhos continuam como links. */}
      <noscript>
        <span className="mt-1.5 flex flex-wrap gap-3 text-small">
          {DASHBOARD_PERIODS.map((n) => (
            <Link key={n} href={presetHref(filters, n)}>
              {presetLabel(n)}
            </Link>
          ))}
        </span>
      </noscript>
    </div>
  );
}
