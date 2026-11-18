import { getOpportunity } from "@/modules/opportunities/queries";
import {
  getConversationCase,
  getStatusTrack,
  listConversationCaseOptions,
  listStatusTrackHistory,
  StatusTrackLoadError,
  type ConversationCaseOption,
  type ConversationCaseOptions,
  type StatusTrackHistoryPage,
  type StatusTrackState,
} from "@/modules/status-tracks/queries";

/**
 * Conversas + IA (PR 2) — tudo que o painel de contexto precisa, já validado
 * no servidor. O FOCO (qual oportunidade o painel mostra) é estado da
 * interface, vem da URL e NUNCA é gravado: o vínculo persistido da conversa
 * (`conversations.opportunity_id`) não muda, e escolher um caso não transfere
 * mensagens nem evidência (docs/decisoes/conversas-ia-fundacao.md).
 */

export const CONTEXT_HISTORY_PAGE_SIZE = 15;

function formatCents(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

export type TrackView = { state: StatusTrackState; history: StatusTrackHistoryPage };

export type FocusCase = {
  option: ConversationCaseOption;
  responsible: string | null;
  nextAction: { title: string; type: string; dueAt: string; hasTime: boolean } | null;
  /** Já projetado por papel pelo servidor: valor exato, faixa ou nada. */
  valueLabel: string | null;
  commercial: TrackView;
  /** Só oportunidade ganha; nas demais o andamento não se aplica. */
  progress: TrackView | null;
};

export type FocusSource = "url" | "linked" | "lead" | "only";

export type ConversationContext = {
  attendance: TrackView;
  cases: ConversationCaseOptions;
  focusId: string | null;
  focusSource: FocusSource | null;
  /** A URL pedia um caso que esta conversa não pode mostrar (outro contato, fora do alcance, inexistente). */
  invalidCaseRequested: boolean;
  focus: FocusCase | null;
};

/**
 * Qual caso vai em foco quando a tela abre. Ordem: o pedido da URL (já
 * validado); senão o vínculo persistido da conversa, se ele é um caso da lista;
 * senão a única oportunidade do lead a que a conversa está ligada; senão o único
 * caso do contato. Com vários casos e nenhuma ligação inequívoca, NADA é
 * escolhido por palpite — a tela pede que a pessoa escolha.
 */
export function resolveFocusId(input: {
  optionIds: readonly string[];
  linkedId: string | null;
  validRequestedId: string | null;
  /** Oportunidades (entre as opções) do lead a que a conversa está ligada. */
  leadOptionIds?: readonly string[];
}): { id: string; source: FocusSource } | null {
  const { optionIds, linkedId, validRequestedId, leadOptionIds = [] } = input;
  if (validRequestedId && optionIds.includes(validRequestedId)) return { id: validRequestedId, source: "url" };
  if (linkedId && optionIds.includes(linkedId)) return { id: linkedId, source: "linked" };
  if (leadOptionIds.length === 1 && optionIds.includes(leadOptionIds[0]!)) return { id: leadOptionIds[0]!, source: "lead" };
  if (optionIds.length === 1) return { id: optionIds[0]!, source: "only" };
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

/**
 * Falha de carregamento SOBE (StatusTrackLoadError/DataLoadError): quem chama
 * decide mostrar o painel em erro, sem derrubar a conversa. Ausência legítima
 * (sem acesso) vira `null`.
 */
export async function loadConversationContext(
  conversationId: string,
  requestedCaseId: string | null,
  conversationLeadId: string | null = null,
): Promise<ConversationContext | null> {
  const [attendance, cases] = await Promise.all([
    loadTrack("attendance", conversationId),
    listConversationCaseOptions(conversationId),
  ]);
  if (!cases) return null;

  // O pedido da URL só vale se o servidor confirmar que é um caso desta conversa.
  const requested = requestedCaseId ? await getConversationCase(conversationId, requestedCaseId) : null;
  const invalidCaseRequested = requestedCaseId !== null && requested === null;

  const resolved = resolveFocusId({
    optionIds: cases.items.map((o) => o.opportunityId),
    linkedId: cases.linkedOpportunityId,
    validRequestedId: requested?.opportunityId ?? null,
    leadOptionIds: conversationLeadId
      ? cases.items.filter((o) => o.leadId === conversationLeadId).map((o) => o.opportunityId)
      : [],
  });

  if (!resolved) {
    return { attendance, cases, focusId: null, focusSource: null, invalidCaseRequested, focus: null };
  }

  const option = cases.items.find((o) => o.opportunityId === resolved.id)!;
  const [opportunity, commercial, progress] = await Promise.all([
    getOpportunity(option.opportunityId),
    loadTrack("commercial_stage", option.opportunityId),
    option.status === "won" ? loadTrack("case_progress", option.opportunityId) : Promise.resolve(null),
  ]);

  const valueLabel =
    opportunity?.valueCents !== undefined
      ? formatCents(opportunity.valueCents)
      : (opportunity?.valueBand ?? null);

  return {
    attendance,
    cases,
    focusId: resolved.id,
    focusSource: resolved.source,
    invalidCaseRequested,
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
      commercial,
      progress,
    },
  };
}
