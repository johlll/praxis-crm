import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError } from "@/server/data/load-error";

export type LeadTimelineEventType = "nota" | "atividade" | "mensagem" | "etapa" | "proposta" | "conflito";

export type LeadTimelineEvent = {
  eventType: LeadTimelineEventType;
  occurredAt: string;
  id: string;
  payload: Record<string, unknown>;
};

const PAGE_SIZE = 30;

/**
 * Mesmo espírito de ActivitiesLoadError/ConversationsLoadError (A6/A7):
 * falha de consulta nunca vira timeline vazia disfarçada de "sem eventos
 * ainda" — sobe pura até error.tsx da rota.
 */
export class LeadTimelineLoadError extends DataLoadError {
  constructor(resource: string, cause?: unknown) {
    super(resource, cause);
    this.name = "LeadTimelineLoadError";
  }
}

function mapEventRow(row: Record<string, unknown>): LeadTimelineEvent {
  return {
    eventType: row.event_type as LeadTimelineEventType,
    occurredAt: row.occurred_at as string,
    id: row.id as string,
    payload: (row.payload as Record<string, unknown>) ?? {},
  };
}

export async function getLeadTimelinePage(
  leadId: string,
  opts: {
    types?: LeadTimelineEventType[] | undefined;
    before?: { occurredAt: string; id: string } | undefined;
  } = {},
): Promise<{ items: LeadTimelineEvent[]; hasMore: boolean }> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_lead_timeline", {
    p_lead_id: leadId,
    p_limit: PAGE_SIZE,
    ...(opts.types ? { p_types: opts.types } : {}),
    ...(opts.before ? { p_before: opts.before.occurredAt, p_before_id: opts.before.id } : {}),
  });

  if (error) {
    throw new LeadTimelineLoadError(`o histórico do lead ${leadId}`, error);
  }
  if (!data || data.length === 0) {
    return { items: [], hasMore: false };
  }

  const row = data[0]!;
  const items = (row.items as unknown as Array<Record<string, unknown>> | null) ?? [];
  return { items: items.map(mapEventRow), hasMore: row.has_more };
}
