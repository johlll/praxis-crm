"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDateTime } from "@/lib/timezone";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";
import { MESSAGE_STATUS_LABEL } from "@/components/conversations/labels";
import type { LeadTimelineEvent, LeadTimelineEventType } from "@/modules/timeline/queries";
import { loadMoreLeadTimelineAction } from "@/modules/timeline/actions";
import { restoreCalendarConflictAction } from "@/modules/calendar/conflict-actions";
import type { CalendarNotice } from "@/modules/calendar/types";
import type { TeamMember } from "@/modules/team/queries";
import type { ActivityType } from "@/modules/activities/queries";

const FILTERS: { key: LeadTimelineEventType | "todos"; label: string }[] = [
  { key: "todos", label: "Todos" },
  { key: "mensagem", label: "Conversas" },
  { key: "atividade", label: "Atividades" },
  { key: "etapa", label: "Alterações" },
  { key: "proposta", label: "Propostas" },
  { key: "agenda", label: "Agenda" },
];

const CALENDAR_FIELD_LABEL: Record<string, string> = {
  title: "título",
  schedule: "horário",
  cancellation: "cancelamento",
  meet: "Meet",
};

/** Valor de um lado do conflito de agenda, legível (título ou início do horário). */
function conflictValue(field: string, value: unknown): string {
  if (field === "title") return typeof value === "string" ? `“${value}”` : "—";
  if (field === "schedule" && value && typeof value === "object" && "start" in value) {
    const start = (value as { start?: unknown }).start;
    return typeof start === "string" ? formatDateTime(start) : "—";
  }
  if (field === "cancellation") return "evento cancelado no Google";
  return "—";
}

/**
 * Conflito de agenda (B2, §6.4): o Google prevaleceu e o valor do CRM ficou
 * gravado. Quem pode, restaura o valor do CRM — o servidor confere tudo de
 * novo (dono da agenda, alcance, valor ainda atual) antes de alterar.
 */
function RestoreConflictButton({ conflictId }: { conflictId: string }) {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<CalendarNotice | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className="mt-1 flex flex-col gap-1">
      {notice ? null : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={pending}
          onClick={() => {
            setFailure(null);
            startTransition(async () => {
              const result = await restoreCalendarConflictAction(conflictId);
              if (!result.ok) {
                setFailure(result.error ?? "Não foi possível restaurar.");
                return;
              }
              setNotice(result.notice ?? null);
            });
          }}
        >
          {pending ? "Restaurando…" : "Restaurar valor do CRM"}
        </Button>
      )}
      {notice ? (
        <Alert variant={notice.level === "warning" ? "warning" : "success"}>
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      ) : null}
      {failure ? (
        <Alert variant="danger">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function memberName(members: TeamMember[], userId: string | null | undefined): string {
  if (!userId) return "Alguém";
  return members.find((m) => m.userId === userId)?.fullName ?? "Alguém";
}

function EventRow({
  event,
  members,
  canRestoreCalendar,
}: {
  event: LeadTimelineEvent;
  members: TeamMember[];
  canRestoreCalendar: boolean;
}) {
  const p = event.payload;
  let restoreId: string | null = null;

  let title = "";
  let detail = "";
  switch (event.eventType) {
    case "nota":
      title = `Anotação de ${memberName(members, p.created_by as string)}`;
      detail = String(p.body ?? "");
      break;
    case "atividade": {
      const type = p.type as ActivityType;
      const done = p.status === "done";
      title = ACTIVITY_TYPE_LABEL[type] ?? "Atividade";
      // Nunca só o título puro: coincidiria por igualdade exata com o
      // título da mesma atividade na ActivitiesSection, visível na
      // mesma tela (achado real do e2e) — o status junto no mesmo nó de
      // texto garante que os dois nunca sejam idênticos.
      detail = `${String(p.title ?? "")} — ${done ? "concluída" : "agendada"}`;
      break;
    }
    case "mensagem": {
      const outbound = p.direction === "outbound";
      title = outbound ? "Mensagem enviada" : "Mensagem recebida";
      const status = p.status as keyof typeof MESSAGE_STATUS_LABEL | undefined;
      detail = `${String(p.body_text ?? "")}${outbound && status ? ` — ${MESSAGE_STATUS_LABEL[status]}` : ""}`;
      break;
    }
    case "etapa":
      title = "Etapa alterada";
      detail = p.from_stage_name
        ? `${String(p.from_stage_name)} → ${String(p.to_stage_name)}`
        : `Entrou em ${String(p.to_stage_name)}`;
      break;
    case "proposta": {
      const value =
        typeof p.value_cents === "number"
          ? (p.value_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
          : (p.value_band as string | undefined);
      title = `Proposta ${String(p.number ?? "")}`;
      detail = `Status: ${String(p.status ?? "")}${value ? ` — ${value}` : ""}`;
      break;
    }
    case "conflito":
      title = "Verificação de conflito registrada";
      detail = `Status: ${String(p.status ?? "")}`;
      break;
    case "agenda": {
      const field = String(p.field ?? "");
      const label = CALENDAR_FIELD_LABEL[field] ?? field;
      const activity = String(p.activity_title ?? "");
      if (p.kind === "restored") {
        title = `Valor do CRM restaurado (${label})`;
        detail = `${activity} — restaurado por ${memberName(members, p.restored_by as string)}: ${conflictValue(field, p.crm_value)}`;
      } else {
        title = `Conflito com o Google Agenda (${label})`;
        detail =
          field === "cancellation"
            ? `${activity} — o evento foi cancelado no Google enquanto o CRM o alterava; a atividade continua no CRM.`
            : `${activity} — o Google prevaleceu: ${conflictValue(field, p.google_value)}. Valor do CRM guardado: ${conflictValue(field, p.crm_value)}.`;
        if (p.restored_at) detail += " Já restaurado.";
        if (canRestoreCalendar && p.restorable === true && typeof p.conflict_id === "string") restoreId = p.conflict_id;
      }
      break;
    }
  }

  return (
    <li className="flex flex-col gap-0.5 border-l-2 border-border py-2 pl-3">
      <span className="text-body font-semibold text-text">{title}</span>
      {detail ? <span className="text-meta text-text-secondary">{detail}</span> : null}
      <span className="font-mono text-meta text-text-tertiary">{formatDateTime(event.occurredAt)}</span>
      {restoreId ? <RestoreConflictButton conflictId={restoreId} /> : null}
    </li>
  );
}

export function LeadTimeline({
  leadId,
  initialItems,
  initialHasMore,
  members,
  showFilters = true,
  canRestoreCalendar = false,
}: {
  leadId: string;
  initialItems: LeadTimelineEvent[];
  initialHasMore: boolean;
  members: TeamMember[];
  showFilters?: boolean;
  /** Mostra "Restaurar valor do CRM" nos conflitos de agenda (`calendar.connect_own`). */
  canRestoreCalendar?: boolean;
}) {
  const [filter, setFilter] = useState<LeadTimelineEventType | "todos">("todos");
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [syncedInitialItems, setSyncedInitialItems] = useState(initialItems);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // useState só usa initialItems no primeiro mount — sem isto, uma
  // anotação/proposta criada por uma Server Action IRMÃ (composer,
  // ProposalsSection) revalida a página e o servidor manda um
  // `initialItems` novo, mas esta timeline continuava presa aos dados do
  // primeiro carregamento (achado real ao validar no preview). Ajuste
  // durante a renderização (padrão recomendado pelo React para resetar
  // estado quando uma prop muda — nunca um setState dentro de useEffect,
  // que dispararia uma renderização em cascata) — reseta para a primeira
  // página sempre que o servidor manda dados novos, aceitável já que os
  // dados mudaram de verdade.
  //
  // `initialItems` é sempre a primeira página de TODOS os tipos — então o
  // filtro volta explicitamente para "Todos" junto com ela. Manter
  // "Propostas" selecionado sobre eventos de todos os tipos deixaria o
  // chip e a lista mentindo um sobre o outro.
  if (initialItems !== syncedInitialItems) {
    setSyncedInitialItems(initialItems);
    setItems(initialItems);
    setHasMore(initialHasMore);
    setFilter("todos");
    setError(null);
  }

  // O filtro precisa ser aplicado na CONSULTA ao servidor, não só na
  // lista já carregada: `items` é sempre a primeira página (30 eventos
  // recentes de QUALQUER tipo), então filtrar em memória escondia
  // eventos mais antigos de um tipo escolhido mesmo quando eles existem
  // de verdade (achado do review pós-CI — "Propostas" podia mostrar
  // "Nenhum evento ainda" com uma proposta real fora da primeira
  // página). O servidor já aceita `p_types`; só faltava a interface usar.
  //
  // O chip só muda DEPOIS que a busca do novo tipo dá certo: numa falha, o
  // filtro indicado continua sendo o dos resultados que estão na tela.
  function selectFilter(next: LeadTimelineEventType | "todos") {
    if (next === filter) return;
    setError(null);
    startTransition(async () => {
      const types = next === "todos" ? null : [next];
      const result = await loadMoreLeadTimelineAction(leadId, types);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setFilter(next);
      setItems(result.items);
      setHasMore(result.hasMore);
    });
  }

  function loadMore() {
    const last = items[items.length - 1];
    if (!last) return;
    setError(null);
    const types = filter === "todos" ? null : [filter];
    startTransition(async () => {
      const result = await loadMoreLeadTimelineAction(leadId, types, { occurredAt: last.occurredAt, id: last.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setItems((prev) => [...prev, ...result.items]);
      setHasMore(result.hasMore);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {showFilters ? (
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => selectFilter(f.key)}
              aria-pressed={filter === f.key}
              disabled={pending}
              className={`h-7 rounded-full border px-3 text-meta font-medium ${
                filter === f.key
                  ? "border-primary bg-primary-tint text-primary"
                  : "border-border bg-surface text-text-secondary"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="py-4 text-body text-text-tertiary">
          {pending ? "Carregando…" : "Nenhum evento ainda."}
        </p>
      ) : (
        <ul className="flex flex-col gap-0">
          {items.map((event) => (
            <EventRow key={`${event.eventType}-${event.id}`} event={event} members={members} canRestoreCalendar={canRestoreCalendar} />
          ))}
        </ul>
      )}

      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {hasMore ? (
        <Button type="button" variant="secondary" size="sm" onClick={loadMore} disabled={pending}>
          {pending ? "Carregando…" : "Carregar mais"}
        </Button>
      ) : null}
    </div>
  );
}
