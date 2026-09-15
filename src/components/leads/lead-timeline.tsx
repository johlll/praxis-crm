"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDateTime } from "@/lib/timezone";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";
import { MESSAGE_STATUS_LABEL } from "@/components/conversations/labels";
import type { LeadTimelineEvent, LeadTimelineEventType } from "@/modules/timeline/queries";
import { loadMoreLeadTimelineAction } from "@/modules/timeline/actions";
import type { TeamMember } from "@/modules/team/queries";
import type { ActivityType } from "@/modules/activities/queries";

const FILTERS: { key: LeadTimelineEventType | "todos"; label: string }[] = [
  { key: "todos", label: "Todos" },
  { key: "mensagem", label: "Conversas" },
  { key: "atividade", label: "Atividades" },
  { key: "etapa", label: "Alterações" },
  { key: "proposta", label: "Propostas" },
];

function memberName(members: TeamMember[], userId: string | null | undefined): string {
  if (!userId) return "Alguém";
  return members.find((m) => m.userId === userId)?.fullName ?? "Alguém";
}

function EventRow({ event, members }: { event: LeadTimelineEvent; members: TeamMember[] }) {
  const p = event.payload;

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
  }

  return (
    <li className="flex flex-col gap-0.5 border-l-2 border-border py-2 pl-3">
      <span className="text-body font-semibold text-text">{title}</span>
      {detail ? <span className="text-meta text-text-secondary">{detail}</span> : null}
      <span className="font-mono text-meta text-text-tertiary">{formatDateTime(event.occurredAt)}</span>
    </li>
  );
}

export function LeadTimeline({
  leadId,
  initialItems,
  initialHasMore,
  members,
  showFilters = true,
}: {
  leadId: string;
  initialItems: LeadTimelineEvent[];
  initialHasMore: boolean;
  members: TeamMember[];
  showFilters?: boolean;
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
  if (initialItems !== syncedInitialItems) {
    setSyncedInitialItems(initialItems);
    setItems(initialItems);
    setHasMore(initialHasMore);
  }

  // O filtro precisa ser aplicado na CONSULTA ao servidor, não só na
  // lista já carregada: `items` é sempre a primeira página (30 eventos
  // recentes de QUALQUER tipo), então filtrar em memória escondia
  // eventos mais antigos de um tipo escolhido mesmo quando eles existem
  // de verdade (achado do review pós-CI — "Propostas" podia mostrar
  // "Nenhum evento ainda" com uma proposta real fora da primeira
  // página). O servidor já aceita `p_types`; só faltava a interface usar.
  function selectFilter(next: LeadTimelineEventType | "todos") {
    setFilter(next);
    setError(null);
    startTransition(async () => {
      const types = next === "todos" ? null : [next];
      const result = await loadMoreLeadTimelineAction(leadId, types);
      if (!result.ok) {
        setError(result.error);
        return;
      }
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
            <EventRow key={`${event.eventType}-${event.id}`} event={event} members={members} />
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
