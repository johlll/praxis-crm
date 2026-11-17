"use client";

import { useRef, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import {
  WEEKDAYS,
  addDays,
  formatFullDate,
  formatMonthLabel,
  isoWeekday,
  monthOf,
  monthWeeks,
  type MonthKey,
} from "@/lib/calendar-month";

function countLabel(n: number): string {
  if (n === 0) return "nenhuma atividade";
  return n === 1 ? "1 atividade" : `${n} atividades`;
}

/**
 * Calendário do mês, de segunda a domingo. Cada dia é um botão compacto
 * (número + contagem discreta); os controles das atividades ficam no painel
 * do dia, nunca dentro das casas. Teclado: setas andam entre os dias do mês,
 * Home/End vão ao início/fim da semana, PageUp/PageDown trocam de mês.
 */
export function MonthCalendar({
  month,
  today,
  selected,
  dayCounts,
  busy,
  onSelectDay,
  onPreviousMonth,
  onNextMonth,
  onToday,
}: {
  month: MonthKey;
  today: string;
  selected: string;
  dayCounts: Record<string, number>;
  busy: boolean;
  onSelectDay: (day: string) => void;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const weeks = monthWeeks(month);
  const label = formatMonthLabel(month);

  function move(target: string) {
    if (monthOf(target) !== month) return;
    onSelectDay(target);
    buttons.current.get(target)?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    const wd = isoWeekday(selected);
    const keys: Record<string, () => void> = {
      ArrowLeft: () => move(addDays(selected, -1)),
      ArrowRight: () => move(addDays(selected, 1)),
      ArrowUp: () => move(addDays(selected, -7)),
      ArrowDown: () => move(addDays(selected, 7)),
      Home: () => move(monthOf(addDays(selected, 1 - wd)) === month ? addDays(selected, 1 - wd) : `${month}-01`),
      End: () => {
        const end = addDays(selected, 7 - wd);
        move(monthOf(end) === month ? end : weeks.flat().filter(Boolean).at(-1)!);
      },
      PageUp: onPreviousMonth,
      PageDown: onNextMonth,
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }

  return (
    <section
      aria-labelledby="agenda-mes-titulo"
      aria-busy={busy}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-3 sm:p-4 lg:sticky lg:top-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="agenda-mes-titulo" aria-live="polite" className="m-0 text-lead font-bold text-text">
          {label}
        </h2>
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={onPreviousMonth} aria-label="Mês anterior" title="Mês anterior">
            <ChevronLeft size={16} aria-hidden />
          </Button>
          <Button variant="secondary" size="sm" onClick={onToday}>
            Hoje
          </Button>
          <Button variant="secondary" size="sm" onClick={onNextMonth} aria-label="Próximo mês" title="Próximo mês">
            <ChevronRight size={16} aria-hidden />
          </Button>
        </div>
      </div>

      <table
        className={cn("w-full table-fixed border-separate border-spacing-0.5 transition-opacity sm:border-spacing-1", busy && "opacity-60")}
        onKeyDown={handleKeyDown}
      >
        <caption className="sr-only">
          {label}. Use as setas para mudar de dia e Page Up ou Page Down para mudar de mês.
        </caption>
        <thead>
          <tr>
            {WEEKDAYS.map((wd) => (
              <th
                key={wd.short}
                scope="col"
                abbr={wd.long}
                className="pb-1 text-center text-meta font-semibold text-text-muted"
              >
                <span aria-hidden>{wd.short}</span>
                <span className="sr-only">{wd.long}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, i) => (
            <tr key={i}>
              {week.map((day, j) =>
                day ? (
                  <td key={day} className="p-0">
                    <DayCell
                      day={day}
                      count={dayCounts[day] ?? 0}
                      isToday={day === today}
                      isSelected={day === selected}
                      onSelect={() => onSelectDay(day)}
                      register={(el) => {
                        if (el) buttons.current.set(day, el);
                        else buttons.current.delete(day);
                      }}
                    />
                  </td>
                ) : (
                  <td key={`vazio-${i}-${j}`} className="p-0" aria-hidden />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function DayCell({
  day,
  count,
  isToday,
  isSelected,
  onSelect,
  register,
}: {
  day: string;
  count: number;
  isToday: boolean;
  isSelected: boolean;
  onSelect: () => void;
  register: (el: HTMLButtonElement | null) => void;
}) {
  const number = Number(day.slice(8));
  const name = `${formatFullDate(day)}${isToday ? ", hoje" : ""}, ${countLabel(count)}`;

  return (
    <button
      ref={register}
      type="button"
      aria-label={name}
      aria-pressed={isSelected}
      aria-current={isToday ? "date" : undefined}
      tabIndex={isSelected ? 0 : -1}
      onClick={onSelect}
      data-day={day}
      className={cn(
        "flex h-12 w-full flex-col items-center justify-between rounded-md border px-0.5 py-1 transition-colors sm:h-16 sm:items-start sm:px-1.5 sm:py-1.5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring",
        isSelected
          ? "border-2 border-primary bg-primary-tint"
          : "border-border-subtle bg-surface-subtle hover:border-border-strong hover:bg-surface-hover",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-6 items-center justify-center rounded-full text-small leading-none tabular-nums",
          isToday ? "bg-primary font-bold text-on-solid" : isSelected ? "font-bold text-text" : "font-medium text-text-secondary",
        )}
      >
        {number}
      </span>
      {count > 0 ? (
        <span
          aria-hidden
          className="rounded-pill bg-surface-hover px-1.5 text-label leading-[16px] font-semibold text-text-secondary tabular-nums sm:self-end"
        >
          {count}
        </span>
      ) : (
        <span aria-hidden className="h-4" />
      )}
    </button>
  );
}
