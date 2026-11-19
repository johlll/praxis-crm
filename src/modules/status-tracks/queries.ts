import { createServerSupabaseClient } from "@/server/supabase/server";
import { toUserMessage } from "@/lib/errors";
import { DataLoadError, isExpectedAbsence } from "@/server/data/load-error";
import type { MessageOrigin, MessageSenderClassification } from "@/modules/conversations/queries";

import type { AttendanceStatus, CaseProgressStatus, StatusTrack } from "./schema";

/**
 * Conversas + IA (PR 1) — leituras das trilhas de status
 * (docs/decisoes/conversas-ia-fundacao.md). Contrato de erro de sempre:
 * ausência legítima (inexistente, fora do alcance, outro escritório) → `null`;
 * qualquer outra falha → `StatusTrackLoadError`, nunca "sem dado".
 */

export class StatusTrackLoadError extends DataLoadError {
  constructor(resource: string, cause?: unknown) {
    super(resource, cause);
    this.name = "StatusTrackLoadError";
  }
}

const ABSENCE = ["conversation_not_found", "opportunity_not_found", "insufficient_permission"] as const;

export type StatusTrackState = {
  track: StatusTrack;
  conversationId: string | null;
  opportunityId: string | null;
  /** case_progress de oportunidade não ganha: false (e `status` nulo). */
  applicable: boolean;
  hasRecord: boolean;
  /** attendance/case_progress: código atual ("nao_informado" = legado); commercial_stage: null. */
  status: AttendanceStatus | CaseProgressStatus | null;
  stageId: string | null;
  stageName: string | null;
  version: number;
  automationPaused: boolean;
  automationPausedAt: string | null;
  automationPausedByName: string | null;
  /** Marco de evidência: última decisão humana sobre o estado da trilha. */
  manualDecidedAt: string | null;
};

export function mapStatusTrackState(row: Record<string, unknown>): StatusTrackState {
  return {
    track: row.track as StatusTrack,
    conversationId: (row.conversation_id as string | null) ?? null,
    opportunityId: (row.opportunity_id as string | null) ?? null,
    applicable: row.applicable === true,
    hasRecord: row.has_record === true,
    status: (row.status as AttendanceStatus | CaseProgressStatus | null) ?? null,
    stageId: (row.stage_id as string | null) ?? null,
    stageName: (row.stage_name as string | null) ?? null,
    version: Number(row.version ?? 0),
    automationPaused: row.automation_paused === true,
    automationPausedAt: (row.automation_paused_at as string | null) ?? null,
    automationPausedByName: (row.automation_paused_by_name as string | null) ?? null,
    manualDecidedAt: (row.manual_decided_at as string | null) ?? null,
  };
}

export async function getStatusTrack(track: StatusTrack, targetId: string): Promise<StatusTrackState | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_status_track", { p_track: track, p_target_id: targetId });
  if (error) {
    if (isExpectedAbsence(error, ABSENCE)) return null;
    throw new StatusTrackLoadError(`a trilha ${track} de ${targetId}`, error);
  }
  if (!data) return null;
  return mapStatusTrackState(data as Record<string, unknown>);
}

export type StatusTrackEvidence = {
  messageId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  origin: MessageOrigin;
  senderClassification: MessageSenderClassification;
  contentKind: string;
  createdAt: string;
};

export type StatusTrackEvent = {
  id: string;
  event: "status_changed" | "automation_paused" | "automation_resumed";
  fromStatus: string | null;
  toStatus: string | null;
  fromVersion: number;
  toVersion: number;
  actorKind: "user";
  actorUserId: string;
  actorName: string | null;
  occurredAt: string;
  evidenceCount: number;
  /** Só as referências das conversas que quem lê alcança, sem texto. */
  evidence: StatusTrackEvidence[];
  /** Referências existentes fora do alcance de quem lê. */
  evidenceHidden: number;
  /** Referências apagadas pela retenção/anonimização (a mensagem não existe mais). */
  evidenceRemoved: number;
};

export function mapStatusTrackEvent(row: Record<string, unknown>): StatusTrackEvent {
  const evidence = Array.isArray(row.evidence) ? (row.evidence as Record<string, unknown>[]) : [];
  return {
    id: row.id as string,
    event: row.event as StatusTrackEvent["event"],
    fromStatus: (row.from_status as string | null) ?? null,
    toStatus: (row.to_status as string | null) ?? null,
    fromVersion: Number(row.from_version),
    toVersion: Number(row.to_version),
    actorKind: row.actor_kind as "user",
    actorUserId: row.actor_user_id as string,
    actorName: (row.actor_name as string | null) ?? null,
    occurredAt: row.occurred_at as string,
    evidenceCount: Number(row.evidence_count ?? 0),
    evidence: evidence.map((e) => ({
      messageId: e.message_id as string,
      conversationId: e.conversation_id as string,
      direction: e.direction as StatusTrackEvidence["direction"],
      origin: e.origin as MessageOrigin,
      senderClassification: e.sender_classification as MessageSenderClassification,
      contentKind: e.content_kind as string,
      createdAt: e.created_at as string,
    })),
    evidenceHidden: Number(row.evidence_hidden ?? 0),
    evidenceRemoved: Number(row.evidence_removed ?? 0),
  };
}

export type StatusTrackHistoryCursor = { before: string; beforeId: string };

export type StatusTrackHistoryPage = {
  items: StatusTrackEvent[];
  hasMore: boolean;
  /** Cursor da próxima página (o evento mais antigo desta), ou null. */
  next: StatusTrackHistoryCursor | null;
};

export async function listStatusTrackHistory(
  track: StatusTrack,
  targetId: string,
  opts: { cursor?: StatusTrackHistoryCursor; limit?: number } = {},
): Promise<StatusTrackHistoryPage | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_status_track_history", {
    p_track: track,
    p_target_id: targetId,
    ...(opts.cursor ? { p_before: opts.cursor.before, p_before_id: opts.cursor.beforeId } : {}),
    ...(opts.limit ? { p_limit: opts.limit } : {}),
  });
  if (error) {
    if (isExpectedAbsence(error, ABSENCE)) return null;
    throw new StatusTrackLoadError(`o histórico da trilha ${track} de ${targetId}`, error);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { items?: unknown; has_more?: unknown } | undefined;
  if (!row || !Array.isArray(row.items)) {
    throw new StatusTrackLoadError(`o histórico da trilha ${track} de ${targetId}`);
  }
  const items = (row.items as Record<string, unknown>[]).map(mapStatusTrackEvent);
  const hasMore = row.has_more === true;
  const last = items.at(-1);
  return { items, hasMore, next: hasMore && last ? { before: last.occurredAt, beforeId: last.id } : null };
}

export type ConversationCaseOption = {
  opportunityId: string;
  leadId: string;
  legalArea: string | null;
  leadStatus: string;
  status: "open" | "won" | "lost";
  stageId: string;
  stageName: string;
  /** É o vínculo persistido da conversa (conversations.opportunity_id). */
  isLinked: boolean;
  /** Só para oportunidade ganha ("nao_informado" quando nunca corrigido). */
  caseProgressStatus: CaseProgressStatus | null;
  createdAt: string;
  /** Número interno do caso (etapa B); nulo = sem número (nada é inventado). */
  caseNumber: number | null;
  /** Roteiro ativo (só oportunidade ganha): tipo, etapa atual e contagens; nulos sem roteiro. */
  serviceTypeName: string | null;
  serviceStepName: string | null;
  serviceStepPosition: number | null;
  serviceStepsTotal: number | null;
  serviceStepsCompleted: number | null;
};

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function mapCaseOption(row: Record<string, unknown>): ConversationCaseOption {
  return {
    opportunityId: row.opportunity_id as string,
    leadId: row.lead_id as string,
    legalArea: (row.legal_area as string | null) ?? null,
    leadStatus: row.lead_status as string,
    status: row.status as ConversationCaseOption["status"],
    stageId: row.stage_id as string,
    stageName: row.stage_name as string,
    isLinked: row.is_linked === true,
    caseProgressStatus: (row.case_progress_status as CaseProgressStatus | null) ?? null,
    createdAt: row.created_at as string,
    caseNumber: numOrNull(row.case_number),
    serviceTypeName: (row.service_type_name as string | null) ?? null,
    serviceStepName: (row.service_step_name as string | null) ?? null,
    serviceStepPosition: numOrNull(row.service_step_position),
    serviceStepsTotal: numOrNull(row.service_steps_total),
    serviceStepsCompleted: numOrNull(row.service_steps_completed),
  };
}

/** De onde veio o caso padrão (regra do banco, compartilhada com a lista): vínculo, único do lead, único do contato. */
export type CaseDefaultSource = "linked" | "lead" | "only";

export function isCaseDefaultSource(v: unknown): v is CaseDefaultSource {
  return v === "linked" || v === "lead" || v === "only";
}

export type ConversationCaseOptions = {
  conversationId: string;
  /** Sem contato resolvido não há caso a escolher (resolver o vínculo primeiro). */
  contactResolved: boolean;
  linkedOpportunityId: string | null;
  items: ConversationCaseOption[];
  /**
   * Caso padrão pela regra única do banco (`private.conversation_case_resolution`), a mesma da lista de
   * conversas. Nulo com vários casos e nenhuma ligação inequívoca: nada é escolhido por palpite.
   */
  defaultOpportunityId: string | null;
  defaultSource: CaseDefaultSource | null;
};

export async function listConversationCaseOptions(conversationId: string): Promise<ConversationCaseOptions | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_conversation_case_options", { p_conversation_id: conversationId });
  if (error) {
    if (isExpectedAbsence(error, ABSENCE)) return null;
    throw new StatusTrackLoadError(`os casos da conversa ${conversationId}`, error);
  }
  const row = data as Record<string, unknown> | null;
  if (!row || !Array.isArray(row.items)) {
    throw new StatusTrackLoadError(`os casos da conversa ${conversationId}`);
  }
  const items = (row.items as Record<string, unknown>[]).map(mapCaseOption);
  const defaultId = typeof row.default_opportunity_id === "string" ? row.default_opportunity_id : null;
  // O padrão só vale se for uma das opções devolvidas na MESMA leitura (nunca um id solto).
  const defaultValid = defaultId !== null && items.some((o) => o.opportunityId === defaultId);
  return {
    conversationId: row.conversation_id as string,
    contactResolved: row.contact_resolved === true,
    linkedOpportunityId: (row.linked_opportunity_id as string | null) ?? null,
    items,
    defaultOpportunityId: defaultValid ? defaultId : null,
    defaultSource: defaultValid && isCaseDefaultSource(row.default_source) ? row.default_source : null,
  };
}

/**
 * Valida a oportunidade escolhida como FOCO da conversa (estado da interface,
 * na URL). Não escreve nada: o vínculo persistido não muda e nenhuma mensagem
 * ou evidência é transferida. Caso não selecionável → `null`.
 */
export async function getConversationCase(
  conversationId: string,
  opportunityId: string,
): Promise<(ConversationCaseOption & { conversationId: string; linkedOpportunityId: string | null }) | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_conversation_case", {
    p_conversation_id: conversationId,
    p_opportunity_id: opportunityId,
  });
  if (error) {
    if (isExpectedAbsence(error, [...ABSENCE, "case_not_selectable"])) return null;
    throw new StatusTrackLoadError(`o caso ${opportunityId} da conversa ${conversationId}`, error);
  }
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    ...mapCaseOption(row),
    conversationId: row.conversation_id as string,
    linkedOpportunityId: (row.linked_opportunity_id as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------
// Resultado das correções e da pausa (usado pelas Server Actions)
// ---------------------------------------------------------------------

export type TrackMutationResult = {
  trackId: string;
  track: StatusTrack;
  conversationId: string | null;
  opportunityId: string | null;
  status: AttendanceStatus | CaseProgressStatus | null;
  version: number;
  automationPaused: boolean;
  manualDecidedAt: string | null;
  eventId: string;
  /** Mesma chave de idempotência e mesmo pedido: nada novo foi gravado. */
  replayed: boolean;
};

/**
 * `conflict`: a versão lida já não é a atual (alguém corrigiu, pausou ou retomou
 * no meio). A tela mostra "o registro mudou" e oferece atualizar; nunca repete a
 * alteração à força.
 */
export type TrackActionState =
  | { ok: true; result: TrackMutationResult }
  | { ok: false; error: string; conflict?: true };

export function trackFailure(error: { message?: string } | null | undefined): TrackActionState & { ok: false } {
  const message = (error as { message?: string } | null | undefined)?.message;
  return {
    ok: false,
    error: toUserMessage(error),
    ...(message === "track_conflict" ? { conflict: true as const } : {}),
  };
}

export function mapTrackMutation(row: Record<string, unknown>): TrackMutationResult {
  return {
    trackId: row.track_id as string,
    track: row.track as StatusTrack,
    conversationId: (row.conversation_id as string | null) ?? null,
    opportunityId: (row.opportunity_id as string | null) ?? null,
    status: (row.status as AttendanceStatus | CaseProgressStatus | null) ?? null,
    version: Number(row.version),
    automationPaused: row.automation_paused === true,
    manualDecidedAt: (row.manual_decided_at as string | null) ?? null,
    eventId: row.event_id as string,
    replayed: row.replayed === true,
  };
}
