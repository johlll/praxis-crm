"use client";

import { useMemo, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  agendaHref,
  dayKeyOf,
  firstDayOf,
  monthOf,
  resolveSelectedDay,
  shiftMonth,
  type MonthKey,
} from "@/lib/calendar-month";
import type { ActivityListItem } from "@/modules/activities/queries";
import type { LeadListItem } from "@/modules/leads/queries";
import type { TeamMember } from "@/modules/team/queries";
import { MonthCalendar } from "./month-calendar";
import { DayPanel } from "./day-panel";

/**
 * Agenda mensal: calendário à esquerda e painel do dia à direita (no
 * celular e em larguras menores, um embaixo do outro).
 *
 * O mês vem do servidor (as atividades do mês inteiro, já no alcance do
 * usuário). O dia selecionado vive na URL (`?mes=AAAA-MM&dia=AAAA-MM-DD`):
 * escolher um dia do mesmo mês só troca a URL pelo History API — o Next
 * sincroniza `useSearchParams`, sem nova busca —, e trocar de mês navega
 * de verdade (nova busca no servidor). Recarregar e Voltar/Avançar
 * reproduzem a mesma seleção, e uma revalidação depois de editar,
 * concluir ou criar mantém o mês e o dia.
 */
export function MonthAgenda({
  month,
  today,
  items,
  dayCounts,
  canEdit,
  members,
  leadOptions,
}: {
  month: MonthKey;
  today: string;
  items: ActivityListItem[];
  dayCounts: Record<string, number>;
  canEdit: boolean;
  members: TeamMember[];
  leadOptions: LeadListItem[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, startTransition] = useTransition();
  const selected = resolveSelectedDay(searchParams.get("dia"), month, today);

  const byDay = useMemo(() => {
    const map = new Map<string, ActivityListItem[]>();
    for (const item of items) {
      const key = dayKeyOf(item.dueAt);
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return map;
  }, [items]);

  function selectDay(day: string) {
    if (day === selected) return;
    window.history.pushState(null, "", agendaHref(month, day));
  }

  function goTo(nextMonth: MonthKey, day: string) {
    startTransition(() => router.push(agendaHref(nextMonth, day), { scroll: false }));
  }

  function goToday() {
    if (monthOf(today) === month) selectDay(today);
    else goTo(monthOf(today), today);
  }

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
      <MonthCalendar
        month={month}
        today={today}
        selected={selected}
        dayCounts={dayCounts}
        busy={busy}
        onSelectDay={selectDay}
        onPreviousMonth={() => {
          const prev = shiftMonth(month, -1);
          goTo(prev, firstDayOf(prev));
        }}
        onNextMonth={() => {
          const next = shiftMonth(month, 1);
          goTo(next, firstDayOf(next));
        }}
        onToday={goToday}
      />
      <DayPanel
        key={selected}
        day={selected}
        items={byDay.get(selected) ?? []}
        canEdit={canEdit}
        members={members}
        leadOptions={leadOptions}
        busy={busy}
      />
    </div>
  );
}
