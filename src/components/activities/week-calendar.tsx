"use client";

import { useMemo } from "react";

import type { ActivityListItem } from "@/modules/activities/queries";
import type { TeamMember } from "@/modules/team/queries";
import { TIMEZONE, formatTime } from "@/lib/timezone";
import { ACTIVITY_TYPE_LABEL } from "./labels";
import { ActivityRowActions } from "./activity-row-actions";

const WEEKDAY_LABEL = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];

/** Chave "YYYY-MM-DD" no fuso do escritório — usada só para agrupar
 * visualmente por dia, nunca para decidir "atrasada"/regra de negócio
 * (isso já vem pronto do servidor). */
function dayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(iso));
}

/** As 7 datas (segunda a domingo) da semana ATUAL, no fuso do escritório
 * — mesmo critério de início de semana usado no servidor
 * (date_trunc('week', ...), ISO 8601). Calculado a partir do relógio do
 * navegador só para desenhar os CABEÇALHOS das colunas (rótulo "10/09");
 * quais atividades caem em qual dia já vem decidido pelo filtro 'week' do
 * servidor — este cálculo nunca decide isso sozinho. */
function currentWeekDates(): Date[] {
  const now = new Date();
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(now);
  const [y, m, d] = todayKey.split("-").map(Number) as [number, number, number];
  const today = new Date(Date.UTC(y, m - 1, d));
  const isoWeekday = today.getUTCDay() === 0 ? 7 : today.getUTCDay();
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - (isoWeekday - 1));
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + i);
    return day;
  });
}

export function WeekCalendar({
  items,
  members,
  canEdit,
}: {
  items: ActivityListItem[];
  members: TeamMember[];
  canEdit: boolean;
}) {
  const weekDates = useMemo(() => currentWeekDates(), []);
  const byDay = useMemo(() => {
    const map = new Map<string, ActivityListItem[]>();
    for (const item of items) {
      const key = dayKey(item.dueAt);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return map;
  }, [items]);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
      {weekDates.map((date, i) => {
        const key = date.toISOString().slice(0, 10);
        const dayItems = byDay.get(key) ?? [];
        return (
          <div key={key} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-2.5">
            <div className="flex items-baseline justify-between">
              <span className="text-small font-semibold text-text">{WEEKDAY_LABEL[i]}</span>
              <span className="text-meta text-text-tertiary">
                {date.getUTCDate().toString().padStart(2, "0")}/{(date.getUTCMonth() + 1).toString().padStart(2, "0")}
              </span>
            </div>
            {dayItems.length === 0 ? (
              <p className="text-meta text-text-tertiary">—</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {dayItems.map((item) => (
                  <li key={item.id} className="flex flex-col gap-1 rounded-input border border-border-subtle px-2 py-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <span
                        className={
                          item.status === "done"
                            ? "text-meta text-text-tertiary line-through"
                            : "text-meta font-medium text-text"
                        }
                      >
                        {item.hasTime ? `${formatTime(item.dueAt)} — ` : ""}
                        {item.title}
                      </span>
                    </div>
                    <span className="text-label text-text-tertiary">
                      {ACTIVITY_TYPE_LABEL[item.type]} · {item.contactName}
                    </span>
                    {canEdit ? <ActivityRowActions activity={item} members={members} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
