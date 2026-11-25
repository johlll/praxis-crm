"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { History } from "lucide-react";

import { Button } from "@/components/ui/button";
import { loadCaseServiceHistoryAction } from "@/modules/case-service/actions";
import type { CaseServiceHistoryCursor, CaseServiceHistoryPage } from "@/modules/case-service/queries";
import type { CaseServiceEvent } from "@/modules/case-service/schema";
import { loadStatusTrackHistoryAction } from "@/modules/status-tracks/actions";
import type { StatusTrackHistoryCursor, StatusTrackHistoryPage } from "@/modules/status-tracks/queries";
import { historyActorLabel, type StatusTrack } from "@/modules/status-tracks/schema";
import {
  TRACK_LABEL,
  TRACK_TAG,
  compareStampDesc,
  describeTrackEvent,
  evidenceAbsenceNote,
  evidenceRefLabel,
  formatStamp,
  mergeTimeline,
  serviceEventExtra,
  type CaseHistoryExtra,
  type TaggedEvent,
} from "@/modules/conversations/context-format";

export type TimelineSource = { track: StatusTrack; targetId: string; page: StatusTrackHistoryPage };

/** Histórico do roteiro do caso (case_service_events), com a própria paginação no servidor. */
export type ServiceTimelineSource = { opportunityId: string; page: CaseServiceHistoryPage };

type Row = { kind: "track"; e: TaggedEvent } | { kind: "extra"; e: CaseHistoryExtra };

function rowSort(a: Row, b: Row): number {
  return compareStampDesc(a.e, b.e);
}

type ServiceState = { opportunityId: string; items: CaseServiceEvent[]; next: CaseServiceHistoryCursor | null };

/** Acrescenta uma página ao fim, sem repetir evento já mostrado (o cursor já evita; isto é a garantia da tela). */
function appendUnique(items: CaseServiceEvent[], more: CaseServiceEvent[]): CaseServiceEvent[] {
  const seen = new Set(items.map((e) => e.id));
  return [...items, ...more.filter((e) => !seen.has(e.id))];
}

function Tag({ children }: { children: string }) {
  return (
    <span className="w-fit rounded-full bg-surface-muted px-1.5 py-px text-label font-semibold text-text-tertiary">{children}</span>
  );
}

type SourceState = { track: StatusTrack; targetId: string; items: TaggedEvent[]; next: StatusTrackHistoryCursor | null };

/**
 * Histórico do caso, só de fontes canônicas e sem duplicar evento: as trilhas de status
 * (`status_track_events`: situação do atendimento, andamento do serviço e as pausas) e, quando vierem em
 * `extra`, as movimentações da etapa comercial (`stage_transitions`) e os marcos gravados na própria
 * oportunidade (abertura, ganho e número interno); e, em `service`, o roteiro do serviço
 * (`case_service_events`), paginado no servidor como as trilhas. Cada fonte paginada tem o próprio
 * "Mais antigos", que busca a página seguinte pelo cursor (horário exato + id). Cada evento traz a origem, quem e quando, de → para e as REFERÊNCIAS das
 * mensagens de evidência — nunca o texto delas.
 */
export function HistoryTimeline({
  sources,
  currentConversationId,
  extra = [],
  service = null,
}: {
  sources: TimelineSource[];
  currentConversationId: string;
  extra?: CaseHistoryExtra[];
  service?: ServiceTimelineSource | null;
}) {
  const [state, setState] = useState<SourceState[]>(() =>
    sources.map((s) => ({
      track: s.track,
      targetId: s.targetId,
      items: s.page.items.map((e) => ({ ...e, track: s.track, targetId: s.targetId })),
      next: s.page.next,
    })),
  );
  const [serviceState, setServiceState] = useState<ServiceState | null>(() =>
    service ? { opportunityId: service.opportunityId, items: service.page.items, next: service.page.next } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const events = mergeTimeline(state.flatMap((s) => s.items));
  const rows: Row[] = [
    ...events.map((e) => ({ kind: "track" as const, e })),
    ...extra.map((e) => ({ kind: "extra" as const, e })),
    ...(serviceState?.items ?? []).map((e) => ({ kind: "extra" as const, e: serviceEventExtra(e) })),
  ].sort(rowSort);
  const loadable = state.filter((s) => s.next);

  function loadMoreService(current: ServiceState) {
    if (!current.next) return;
    const cursor = current.next;
    const opportunityId = current.opportunityId;
    setError(null);
    start(async () => {
      const result = await loadCaseServiceHistoryAction({ opportunityId, before: cursor.before, beforeId: cursor.beforeId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Só entra se a lista ainda for a do MESMO caso e do mesmo ponto (resposta atrasada não mistura casos).
      setServiceState((prev) =>
        prev && prev.opportunityId === opportunityId && prev.next?.beforeId === cursor.beforeId
          ? { ...prev, items: appendUnique(prev.items, result.page.items), next: result.page.next }
          : prev,
      );
    });
  }

  function loadMore(source: SourceState) {
    if (!source.next) return;
    const cursor = source.next;
    setError(null);
    start(async () => {
      const result = await loadStatusTrackHistoryAction({
        track: source.track,
        targetId: source.targetId,
        before: cursor.before,
        beforeId: cursor.beforeId,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState((prev) =>
        prev.map((s) =>
          s.track === source.track && s.targetId === source.targetId
            ? {
                ...s,
                items: [...s.items, ...result.page.items.map((e) => ({ ...e, track: s.track, targetId: s.targetId }))],
                next: result.page.next,
              }
            : s,
        ),
      );
    });
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-input border border-dashed border-border px-4 py-5 text-center">
        <History size={16} className="text-text-muted" aria-hidden />
        <p className="m-0 text-meta text-text-tertiary">
          Nenhuma alteração registrada ainda. Dados anteriores ao registro aparecem como “Não informado”.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {rows.map((row) => {
          if (row.kind === "extra") {
            const x = row.e;
            return (
              <li key={x.id} className="flex flex-col gap-1 border-l-2 border-border pl-3">
                <Tag>{x.tag}</Tag>
                <p className="m-0 text-small font-semibold text-text">{x.title}</p>
                {x.detail ? <p className="m-0 text-meta text-text-secondary">{x.detail}</p> : null}
                <p className="m-0 text-meta text-text-tertiary">
                  {x.actorLabel ? <>{x.actorLabel} · </> : null}
                  <time dateTime={x.occurredAt}>{formatStamp(x.occurredAt)}</time>
                </p>
              </li>
            );
          }
          const e = row.e;
          const d = describeTrackEvent(e.track, e);
          const absence = evidenceAbsenceNote(e);
          return (
            <li key={e.id} className="flex flex-col gap-1 border-l-2 border-border pl-3">
              <Tag>{TRACK_TAG[e.track]}</Tag>
              <p className="m-0 text-small font-semibold text-text">{d.title}</p>
              {d.detail ? <p className="m-0 text-meta text-text-secondary">{d.detail}</p> : null}
              <p className="m-0 text-meta text-text-tertiary">
                {historyActorLabel(e.actorKind, e.actorName)} · <time dateTime={e.occurredAt}>{formatStamp(e.occurredAt)}</time>
              </p>
              {e.evidenceCount > 0 ? (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  <p className="m-0 text-meta font-semibold text-text-secondary">
                    Evidência: {e.evidenceCount} {e.evidenceCount === 1 ? "mensagem" : "mensagens"}
                  </p>
                  {e.evidence.length > 0 ? (
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                      {e.evidence.map((ev) => (
                        <li key={ev.messageId} className="text-meta text-text-tertiary">
                          {ev.conversationId === currentConversationId ? (
                            evidenceRefLabel(ev)
                          ) : (
                            <Link href={`/conversas/${ev.conversationId}` as never} className="text-primary hover:underline">
                              {evidenceRefLabel(ev)} (outra conversa)
                            </Link>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {absence ? <p className="m-0 text-meta italic text-text-muted">{absence}</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {error ? (
        <p role="alert" className="m-0 text-meta text-danger">
          {error}
        </p>
      ) : null}

      {loadable.length > 0 || serviceState?.next ? (
        <div className="flex flex-wrap gap-2">
          {loadable.map((s) => (
            <Button key={`${s.track}-${s.targetId}`} type="button" size="sm" variant="secondary" disabled={pending} onClick={() => loadMore(s)}>
              {pending ? "Carregando…" : `Mais antigos — ${TRACK_LABEL[s.track].toLowerCase()}`}
            </Button>
          ))}
          {serviceState?.next ? (
            <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => loadMoreService(serviceState)}>
              {pending ? "Carregando…" : "Mais antigos — roteiro do serviço"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
