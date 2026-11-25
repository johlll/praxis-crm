import { cache } from "react";

import { getOpportunity, listPipelineStages, type OpportunityDetail } from "@/modules/opportunities/queries";
import { listActivities, listAllActivities, type ActivityListItem } from "@/modules/activities/queries";
import { listTeamMembers, type TeamMember } from "@/modules/team/queries";
import {
  getConversationCase,
  getStatusTrack,
  listConversationCaseOptions,
  listStatusTrackHistory,
  StatusTrackLoadError,
  type CaseDefaultSource,
  type ConversationCaseOption,
  type ConversationCaseOptions,
  type StatusTrackHistoryPage,
  type StatusTrackState,
} from "@/modules/status-tracks/queries";
import {
  getCaseService,
  listCaseServiceHistory,
  listServiceTypes,
  CaseServiceLoadError,
  type CaseServiceHistoryPage,
} from "@/modules/case-service/queries";
import type { CaseService, ServiceTypeItem } from "@/modules/case-service/schema";
import { listCaseNotes } from "@/modules/case-notes/queries";
import { CASE_NOTES_SUMMARY, type CaseNotesPage } from "@/modules/case-notes/schema";
import { listCaseDocuments, listCaseProposalPdfs, type CaseProposalPdf } from "@/modules/case-documents/queries";
import type { CaseDocument } from "@/modules/case-documents/schema";
import { commercialSteps, type CaseTab, type FocusSource, type Step } from "./case-display";

/**
 * Conversas + IA — tudo que o painel do caso precisa, já validado no servidor. O FOCO (qual
 * oportunidade o painel mostra) é estado da interface, vem da URL e NUNCA é gravado: o vínculo
 * persistido da conversa (`conversations.opportunity_id`) não muda, e escolher um caso não transfere
 * mensagens nem evidência (docs/decisoes/conversas-ia-fundacao.md).
 *
 * O caso PADRÃO (sem `?caso=`) vem do banco, pela mesma regra que a lista de conversas usa
 * (`private.conversation_case_resolution`): lista e painel nunca divergem, nem em permissão.
 */

export const CONTEXT_HISTORY_PAGE_SIZE = 15;
/** Concluídas mostradas na aba Tarefas (as mais recentes); o total completo fica na oportunidade. */
export const DONE_ACTIVITIES_LIMIT = 20;

function formatCents(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

export type TrackView = { state: StatusTrackState; history: StatusTrackHistoryPage };

/** Movimentação comercial (fonte canônica: `stage_transitions`), com os nomes resolvidos. */
export type StageMove = {
  id: string;
  occurredAt: string;
  fromStageName: string | null;
  toStageName: string;
  actorName: string | null;
};

/**
 * Observações do caso: as mais recentes (Resumo e edição). Falha de leitura é um estado PRÓPRIO — o painel
 * mostra o aviso com nova tentativa no cartão, sem derrubar o caso e sem fingir "nenhuma observação".
 */
export type CaseNotesView = { status: "ok"; page: CaseNotesPage } | { status: "error" } | { status: "unavailable" };

/**
 * Documentos do caso (aba Documentos). Mesmo contrato das observações: falha de leitura é estado PRÓPRIO (aviso
 * com nova tentativa), sem alcance é `unavailable` — nunca "nenhum documento". As propostas em PDF ligadas ao
 * caso vêm à parte: a falha delas não esconde os documentos.
 */
export type CaseDocumentsView =
  | {
      status: "ok";
      items: CaseDocument[];
      uploadGateOpen: boolean;
      proposals: { status: "ok"; items: CaseProposalPdf[] } | { status: "error" };
    }
  | { status: "error" }
  | { status: "unavailable" };

export type FocusCase = {
  option: ConversationCaseOption;
  responsible: string | null;
  nextAction: { title: string; type: string; dueAt: string; hasTime: boolean } | null;
  /** Já projetado por papel pelo servidor: valor exato, faixa ou nada. */
  valueLabel: string | null;
  pipelineName: string | null;
  wonAt: string | null;
  signedAt: string | null;
  lostReasonLabel: string | null;
  commercial: TrackView;
  /** Só oportunidade ganha; nas demais o andamento não se aplica. */
  progress: TrackView | null;
  /** Etapas comerciais (só oportunidade aberta), na ordem do pipeline; nunca "concluídas". */
  steps: Step[] | null;
  /** Movimentações da etapa comercial, da mais recente para a mais antiga. */
  stageMoves: StageMove[];
  /** Tarefas pendentes vinculadas à oportunidade (activities.opportunity_id), por prazo. */
  pendingActivities: ActivityListItem[];
  /** Concluídas mais recentes — só carregadas na aba Tarefas. */
  doneActivities: { items: ActivityListItem[]; total: number } | null;
  /**
   * Etapa B: número interno, roteiro ativo (etapas copiadas, etapa atual, conclusões registradas) e a versão
   * ÚNICA da trilha case_progress (andamento + roteiro).
   */
  service: CaseService;
  /** Histórico do roteiro — só carregado na aba Histórico. */
  serviceHistory: CaseServiceHistoryPage | null;
  /** Catálogo ativo do escritório — só carregado na edição (aplicar ou trocar o roteiro). */
  serviceTypes: ServiceTypeItem[] | null;
  /** Observações do caso — carregadas no Resumo e na edição. `null` nas outras abas. */
  notes: CaseNotesView | null;
  /** Documentos do caso e PDFs de proposta ligados a ele — só carregados na aba Documentos. */
  documents: CaseDocumentsView | null;
};

/** Documentos do caso sem derrubar o painel: falha → `error`; sem alcance → `unavailable`. */
export async function loadCaseDocumentsView(opportunityId: string, leadId: string): Promise<CaseDocumentsView> {
  try {
    const [docs, proposals] = await Promise.all([
      listCaseDocuments(opportunityId),
      listCaseProposalPdfs(leadId, opportunityId).then(
        (items) => ({ status: "ok" as const, items }),
        () => ({ status: "error" as const }),
      ),
    ]);
    if (!docs) return { status: "unavailable" };
    return { status: "ok", items: docs.items, uploadGateOpen: docs.uploadGateOpen, proposals };
  } catch {
    return { status: "error" };
  }
}

/** Primeira página de observações, sem derrubar o painel: falha → `error`; sem alcance → `unavailable`. */
export async function loadCaseNotesView(opportunityId: string): Promise<CaseNotesView> {
  try {
    const page = await listCaseNotes(opportunityId, { limit: CASE_NOTES_SUMMARY });
    return page ? { status: "ok", page } : { status: "unavailable" };
  } catch {
    return { status: "error" };
  }
}

export type ConversationContext = {
  attendance: TrackView;
  cases: ConversationCaseOptions;
  focusId: string | null;
  focusSource: FocusSource | null;
  /** A URL pedia um caso que esta conversa não pode mostrar (outro contato, fora do alcance, inexistente). */
  invalidCaseRequested: boolean;
  focus: FocusCase | null;
  /** Integrantes do escritório (responsáveis das tarefas e autores das movimentações comerciais). */
  members: TeamMember[];
};

/**
 * Qual caso vai em foco. Ordem: o pedido da URL (já validado pelo servidor); senão o caso padrão
 * devolvido pelo banco (vínculo persistido, único do lead ou único do contato). Com vários casos e
 * nenhuma ligação inequívoca o banco não devolve padrão e NADA é escolhido por palpite.
 */
export function resolveFocusId(input: {
  optionIds: readonly string[];
  validRequestedId: string | null;
  serverDefault: { id: string; source: CaseDefaultSource } | null;
}): { id: string; source: FocusSource } | null {
  const { optionIds, validRequestedId, serverDefault } = input;
  if (validRequestedId && optionIds.includes(validRequestedId)) return { id: validRequestedId, source: "url" };
  if (serverDefault && optionIds.includes(serverDefault.id)) return { id: serverDefault.id, source: serverDefault.source };
  return null;
}

async function loadTrack(
  track: "attendance" | "case_progress" | "commercial_stage",
  targetId: string,
): Promise<TrackView> {
  const [state, history] = await Promise.all([
    getStatusTrack(track, targetId),
    listStatusTrackHistory(track, targetId, { limit: CONTEXT_HISTORY_PAGE_SIZE }),
  ]);
  if (!state || !history) throw new StatusTrackLoadError(`a trilha ${track} de ${targetId}`);
  return { state, history };
}

export function memberName(members: readonly TeamMember[], userId: string | null): string | null {
  if (!userId) return null;
  const m = members.find((x) => x.userId === userId);
  return m ? m.fullName?.trim() || m.email : null;
}

export function mapStageMoves(
  history: OpportunityDetail["history"],
  stages: readonly { id: string; name: string }[],
  members: readonly TeamMember[],
): StageMove[] {
  const name = (id: string | null) => (id ? (stages.find((s) => s.id === id)?.name ?? "Etapa removida") : null);
  return history.map((h, i) => ({
    // stage_transitions não chega com id nesta leitura: a chave estável é a posição + horário + destino.
    id: `${h.occurredAt}:${h.toStageId}:${i}`,
    occurredAt: h.occurredAt,
    fromStageName: name(h.fromStageId),
    toStageName: name(h.toStageId) ?? "Etapa removida",
    actorName: memberName(members, h.actorUserId),
  }));
}

/**
 * Falha de carregamento SOBE (StatusTrackLoadError/DataLoadError): quem chama decide mostrar o painel
 * em erro, sem derrubar a conversa. Ausência legítima (sem acesso) vira `null`.
 *
 * Em `cache()` da requisição: o cabeçalho da conversa e o painel leem o MESMO contexto uma vez só (por isso
 * os argumentos são todos primitivos — o cache compara por identidade).
 */
export const loadConversationContext = cache(async function loadConversationContext(
  conversationId: string,
  requestedCaseId: string | null,
  workspaceId: string,
  userId: string,
  tab: CaseTab,
  editing = false,
): Promise<ConversationContext | null> {
  const opts = { workspaceId, userId, tab };
  const [attendance, cases, members] = await Promise.all([
    loadTrack("attendance", conversationId),
    listConversationCaseOptions(conversationId),
    listTeamMembers(opts.workspaceId, opts.userId),
  ]);
  if (!cases) return null;

  // O pedido da URL só vale se o servidor confirmar que é um caso desta conversa.
  const requested = requestedCaseId ? await getConversationCase(conversationId, requestedCaseId) : null;
  const invalidCaseRequested = requestedCaseId !== null && requested === null;

  const resolved = resolveFocusId({
    optionIds: cases.items.map((o) => o.opportunityId),
    validRequestedId: requested?.opportunityId ?? null,
    serverDefault:
      cases.defaultOpportunityId && cases.defaultSource
        ? { id: cases.defaultOpportunityId, source: cases.defaultSource }
        : null,
  });

  if (!resolved) {
    return { attendance, cases, focusId: null, focusSource: null, invalidCaseRequested, focus: null, members };
  }

  const option = cases.items.find((o) => o.opportunityId === resolved.id)!;
  const [opportunity, commercial, progress, pending, done, service, serviceHistory, serviceTypes, notes, documents] = await Promise.all([
    getOpportunity(option.opportunityId),
    loadTrack("commercial_stage", option.opportunityId),
    option.status === "won" ? loadTrack("case_progress", option.opportunityId) : Promise.resolve(null),
    listAllActivities(opts.workspaceId, { opportunityId: option.opportunityId, status: "pending" }),
    opts.tab === "tarefas"
      ? listActivities(opts.workspaceId, {
          opportunityId: option.opportunityId,
          status: "done",
          sort: "due_at_desc",
          pageSize: DONE_ACTIVITIES_LIMIT,
        })
      : Promise.resolve(null),
    getCaseService(option.opportunityId),
    opts.tab === "historico" ? listCaseServiceHistory(option.opportunityId) : Promise.resolve(null),
    editing && option.status === "won" ? listServiceTypes(opts.workspaceId) : Promise.resolve(null),
    editing || opts.tab === "resumo" ? loadCaseNotesView(option.opportunityId) : Promise.resolve(null),
    !editing && opts.tab === "documentos" ? loadCaseDocumentsView(option.opportunityId, option.leadId) : Promise.resolve(null),
  ]);
  if (!service) throw new CaseServiceLoadError(`o serviço do caso ${option.opportunityId}`);

  // Etapas do pipeline: nomes das movimentações e, para oportunidade aberta, o andamento comercial.
  const stages = opportunity ? await listPipelineStages(opportunity.pipelineId) : [];

  // Valor exato só para quem o vê (projeção por papel do servidor); valor não informado não vira "R$ 0,00".
  const valueLabel =
    typeof opportunity?.valueCents === "number"
      ? formatCents(opportunity.valueCents)
      : (opportunity?.valueBand ?? null);

  return {
    attendance,
    cases,
    focusId: resolved.id,
    focusSource: resolved.source,
    invalidCaseRequested,
    members,
    focus: {
      option,
      responsible: opportunity?.assignedToName ?? null,
      nextAction: opportunity?.nextAction
        ? {
            title: opportunity.nextAction.title,
            type: opportunity.nextAction.type,
            dueAt: opportunity.nextAction.dueAt,
            hasTime: opportunity.nextAction.hasTime,
          }
        : null,
      valueLabel,
      pipelineName: opportunity?.pipelineName ?? null,
      wonAt: opportunity?.wonAt ?? null,
      signedAt: opportunity?.signedAt ?? null,
      lostReasonLabel: opportunity?.lostReasonLabel ?? null,
      commercial,
      progress,
      steps: option.status === "open" ? commercialSteps(stages, option.stageId) : null,
      stageMoves: opportunity ? mapStageMoves(opportunity.history, stages, members) : [],
      pendingActivities: pending.items,
      doneActivities: done ? { items: done.items, total: done.total } : null,
      service,
      serviceHistory,
      serviceTypes: serviceTypes ? serviceTypes.filter((t) => !t.archived) : null,
      notes,
      documents,
    },
  };
});
