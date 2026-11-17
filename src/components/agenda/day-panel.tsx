"use client";

import Link from "next/link";
import { AlertCircle, CalendarDays, Check, Clock } from "lucide-react";

import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/timezone";
import { formatFullDate } from "@/lib/calendar-month";
import type { ActivityListItem } from "@/modules/activities/queries";
import type { LeadListItem } from "@/modules/leads/queries";
import type { TeamMember } from "@/modules/team/queries";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";
import { ActivityRowActions } from "@/components/activities/activity-row-actions";
import { CreateActivityDialog } from "@/components/activities/create-activity-dialog";
import { CalendarBadge } from "@/components/calendar/calendar-badge";

function countText(n: number): string {
  if (n === 0) return "Nenhuma atividade";
  return n === 1 ? "1 atividade" : `${n} atividades`;
}

/** Com horário em ordem cronológica; sem horário com as pendentes primeiro. */
export function splitDayItems(items: ActivityListItem[]) {
  const timed = items
    .filter((item) => item.hasTime)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.title.localeCompare(b.title, "pt-BR"));
  const untimed = items
    .filter((item) => !item.hasTime)
    .sort(
      (a, b) =>
        Number(a.status === "done") - Number(b.status === "done") || a.title.localeCompare(b.title, "pt-BR"),
    );
  return { timed, untimed };
}

/**
 * Painel do dia selecionado: data completa, quantidade, "Com horário" e
 * "Sem horário", e as ações que já existiam (concluir, transferir,
 * reagendar, editar, Google Agenda, excluir) — as mesmas permissões e o
 * mesmo fluxo de sempre, só reorganizados.
 */
export function DayPanel({
  day,
  items,
  canEdit,
  members,
  leadOptions,
  busy,
}: {
  day: string;
  items: ActivityListItem[];
  canEdit: boolean;
  members: TeamMember[];
  leadOptions: LeadListItem[];
  busy: boolean;
}) {
  const { timed, untimed } = splitDayItems(items);
  const pending = items.filter((item) => item.status === "pending").length;

  return (
    <section
      aria-labelledby="agenda-dia-titulo"
      aria-busy={busy}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-3 transition-opacity sm:p-4",
        busy && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="agenda-dia-titulo" className="m-0 text-lead font-bold text-text">
            {formatFullDate(day)}
          </h2>
          <p className="m-0 text-small text-text-muted" aria-live="polite">
            {countText(items.length)}
            {items.length > 0 ? ` · ${pending} pendente${pending === 1 ? "" : "s"}` : ""}
          </p>
        </div>
        {/* Sempre no mesmo lugar: se o botão mudasse de posição quando o dia
            deixa de estar vazio, a revalidação depois de criar desmontaria o
            diálogo e levaria junto a confirmação (e o aviso do Google Agenda). */}
        {canEdit ? <CreateActivityDialog leadOptions={leadOptions} members={members} defaultDueDate={day} /> : null}
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border px-4 py-8 text-center">
          <span aria-hidden className="flex size-9 items-center justify-center rounded-card bg-primary-tint text-primary">
            <CalendarDays size={17} />
          </span>
          <p className="m-0 text-body text-text-secondary">Nada agendado para este dia.</p>
          {canEdit ? (
            <p className="m-0 text-small text-text-muted">Use “Nova atividade” para agendar algo nesta data.</p>
          ) : null}
        </div>
      ) : (
        <>
          <DayGroup title="Com horário" items={timed} canEdit={canEdit} members={members} />
          <DayGroup title="Sem horário" items={untimed} canEdit={canEdit} members={members} />
        </>
      )}
    </section>
  );
}

function DayGroup({
  title,
  items,
  canEdit,
  members,
}: {
  title: string;
  items: ActivityListItem[];
  canEdit: boolean;
  members: TeamMember[];
}) {
  if (items.length === 0) return null;
  const id = `agenda-grupo-${title === "Com horário" ? "hora" : "sem-hora"}`;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 id={id} className="m-0 text-meta font-semibold tracking-[0.04em] text-text-muted uppercase">
        {title} <span className="font-normal tabular-nums">({items.length})</span>
      </h3>
      <ul aria-labelledby={id} className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <DayItem key={item.id} item={item} canEdit={canEdit} members={members} />
        ))}
      </ul>
    </div>
  );
}

function StatusTag({ item }: { item: ActivityListItem }) {
  if (item.status === "done") {
    return (
      <span className="inline-flex items-center gap-1 rounded-pill bg-success-bg px-2 py-0.5 text-meta font-semibold text-success">
        <Check size={12} aria-hidden />
        Concluída
      </span>
    );
  }
  if (item.isOverdue) {
    return (
      <span className="inline-flex items-center gap-1 rounded-pill bg-danger-bg px-2 py-0.5 text-meta font-semibold text-danger">
        <AlertCircle size={12} aria-hidden />
        Atrasada
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-pill border border-border px-2 py-0.5 text-meta font-semibold text-text-secondary">
      <Clock size={12} aria-hidden />
      Pendente
    </span>
  );
}

function DayItem({ item, canEdit, members }: { item: ActivityListItem; canEdit: boolean; members: TeamMember[] }) {
  const done = item.status === "done";
  return (
    <li
      data-activity-id={item.id}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-md border px-3 py-2.5",
        item.isOverdue ? "border-danger/35 bg-surface-subtle" : "border-border-subtle bg-surface-subtle",
      )}
    >
      <div className="flex min-w-0 gap-3">
        {item.hasTime ? (
          <time dateTime={item.dueAt} className="w-11 shrink-0 pt-px text-small font-semibold text-text tabular-nums">
            {formatTime(item.dueAt)}
          </time>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-1">
            <p
              className={cn(
                "m-0 min-w-0 text-body font-semibold break-words",
                done ? "text-text-tertiary line-through" : "text-text",
              )}
            >
              {item.title}
            </p>
            <StatusTag item={item} />
          </div>
          <p className="m-0 min-w-0 text-meta break-words text-text-tertiary">
            {ACTIVITY_TYPE_LABEL[item.type]} ·{" "}
            <Link href={`/leads/${item.leadId}`} className="text-text-secondary hover:text-text hover:underline">
              {item.contactName}
            </Link>{" "}
            · {item.assignedToName ? `Responsável: ${item.assignedToName}` : "Sem responsável"}
          </p>
          <CalendarBadge info={item.calendar} />
        </div>
      </div>
      {/* Ações em faixa própria, na largura do cartão: no painel estreito elas
          não se espremem sob o horário. */}
      {canEdit ? (
        <div className="border-t border-border-subtle pt-2 [&_select]:max-w-[220px] [&_select]:min-w-0 [&_select]:flex-1">
          <ActivityRowActions activity={item} members={members} />
        </div>
      ) : null}
    </li>
  );
}
