import { CASE_PROGRESS_STATUS_LABEL, type CaseProgressStatus } from "@/modules/status-tracks/schema";
import type { CaseDefaultSource, ConversationCaseOption } from "@/modules/status-tracks/queries";

/**
 * Conversas + IA — painel do caso: regras puras de exibição do caso (sem banco e sem
 * `server-only`, para valer no servidor e no navegador e ser testado sem rede).
 *
 * Tudo vem de dados gravados: área do lead, etapa do Kanban, andamento registrado,
 * data de abertura. Nenhum código, tipo de serviço ou número de processo é inventado.
 */

// ---------------------------------------------------------------------
// Selo do caso
// ---------------------------------------------------------------------

/**
 * Três naturezas que o selo SEMPRE distingue, com texto (nunca só cor):
 * - `commercial`: oportunidade aberta — a etapa do Kanban;
 * - `service`: oportunidade ganha — o andamento do serviço registrado (ou "não informado");
 * - `lost`: oportunidade perdida.
 * A situação do atendimento (da conversa) nunca entra aqui.
 */
export type CaseBadgeKind = "commercial" | "service" | "lost";

export type CaseBadge = {
  kind: CaseBadgeKind;
  /** Natureza visível: "Comercial", "Serviço" ou "Oportunidade". */
  prefix: string;
  /** Estado: etapa comercial, andamento ou "Perdida". */
  label: string;
  /** Frase completa, para leitor de tela e dica: "Comercial: Proposta enviada". */
  full: string;
  /** Andamento (só `service`), para a cor. */
  progress: CaseProgressStatus | null;
};

export function caseBadge(o: Pick<ConversationCaseOption, "status" | "stageName" | "caseProgressStatus">): CaseBadge {
  if (o.status === "won") {
    const progress: CaseProgressStatus = o.caseProgressStatus ?? "nao_informado";
    const label = progress === "nao_informado" ? "Andamento não informado" : CASE_PROGRESS_STATUS_LABEL[progress];
    return { kind: "service", prefix: "Serviço", label, full: `Serviço: ${label}`, progress };
  }
  if (o.status === "lost") {
    return { kind: "lost", prefix: "Oportunidade", label: "Perdida", full: "Oportunidade perdida", progress: null };
  }
  return { kind: "commercial", prefix: "Comercial", label: o.stageName, full: `Comercial: ${o.stageName}`, progress: null };
}

// ---------------------------------------------------------------------
// Identificação do caso
// ---------------------------------------------------------------------

const DATE = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
const TIME = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

export type CaseIdentity = {
  /** Assunto do caso: a área do lead (texto gravado), ou "Oportunidade sem área". */
  title: string;
  /** "Aberta em 12/03/2026" (sempre). */
  opened: string;
  /**
   * Desempate REAL quando outra oportunidade do contato tem a mesma área e a mesma etapa: a hora de
   * abertura ("às 14:05") e, se até o minuto coincide, o início do identificador ("ref. 1A2B3C4D").
   */
  extra: string | null;
};

function sameShape(a: ConversationCaseOption, b: ConversationCaseOption): boolean {
  return (a.legalArea ?? "") === (b.legalArea ?? "") && a.stageName === b.stageName && a.status === b.status;
}

export function caseIdentity(o: ConversationCaseOption, all: readonly ConversationCaseOption[] = []): CaseIdentity {
  const created = new Date(o.createdAt);
  const opened = `Aberta em ${DATE.format(created)}`;
  const twins = all.filter((x) => x.opportunityId !== o.opportunityId && sameShape(x, o));
  let extra: string | null = null;
  if (twins.length > 0) {
    const sameDay = twins.filter((x) => DATE.format(new Date(x.createdAt)) === DATE.format(created));
    if (sameDay.length > 0) {
      const sameMinute = sameDay.filter((x) => TIME.format(new Date(x.createdAt)) === TIME.format(created));
      extra = sameMinute.length > 0 ? `ref. ${o.opportunityId.slice(0, 8).toUpperCase()}` : `às ${TIME.format(created)}`;
    }
  }
  return { title: o.legalArea?.trim() || "Oportunidade sem área", opened, extra };
}

/** Uma linha só: "Aberta em 12/03/2026 às 14:05". */
export function caseOpenedLine(id: CaseIdentity): string {
  return id.extra ? `${id.opened} ${id.extra.startsWith("ref.") ? `· ${id.extra}` : id.extra}` : id.opened;
}

// ---------------------------------------------------------------------
// Foco (tela) × vínculo (gravado)
// ---------------------------------------------------------------------

export type FocusSource = "url" | CaseDefaultSource;

export type FocusNote = {
  /** `differs`: o caso mostrado NÃO é o vínculo gravado da conversa (há outro, ou nenhum). */
  tone: "linked" | "differs";
  text: string;
  /** Caso vinculado à conversa, quando ele existe e não é o mostrado. */
  linkedId: string | null;
};

/**
 * Explica de onde vem o caso mostrado, deixando claro quando ele não é o vínculo gravado da conversa.
 * Escolher um caso nesta tela nunca altera o vínculo (`conversations.opportunity_id`).
 */
export function focusNote(source: FocusSource, focusId: string, linkedId: string | null): FocusNote {
  if (linkedId !== null && linkedId === focusId) {
    return { tone: "linked", text: "Caso vinculado a esta conversa.", linkedId: null };
  }
  if (source === "url") {
    return linkedId
      ? { tone: "differs", text: "Escolhido nesta tela. A conversa está vinculada a outro caso.", linkedId }
      : { tone: "differs", text: "Escolhido nesta tela. A conversa não tem caso vinculado.", linkedId: null };
  }
  if (source === "lead") {
    return { tone: "differs", text: "Único caso do lead desta conversa. A conversa não tem caso vinculado.", linkedId: null };
  }
  return { tone: "differs", text: "Único caso deste contato. A conversa não tem caso vinculado.", linkedId: null };
}

// ---------------------------------------------------------------------
// Andamento visual (etapas comerciais)
// ---------------------------------------------------------------------

export type StageOption = { id: string; name: string; position: number; isWon?: boolean; isLost?: boolean };

/**
 * Posição relativa no funil: `previous` e `next` são só a ORDEM das etapas, nunca conclusão.
 * O banco não registra "etapa concluída"; marcar as anteriores como feitas seria inferir por posição.
 */
export type StepState = "previous" | "current" | "next";

export type Step = { id: string; name: string; state: StepState };

/**
 * Etapas comerciais (sem as terminais de ganho e perda) na ordem do pipeline, marcando a atual.
 * Devolve `null` se a etapa atual não estiver entre elas (por exemplo, uma etapa terminal).
 */
export function commercialSteps(stages: readonly StageOption[], currentStageId: string): Step[] | null {
  const open = [...stages].filter((s) => !s.isWon && !s.isLost).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const idx = open.findIndex((s) => s.id === currentStageId);
  if (idx < 0) return null;
  return open.map((s, i) => ({ id: s.id, name: s.name, state: i < idx ? "previous" : i === idx ? "current" : "next" }));
}

// ---------------------------------------------------------------------
// Abas do painel
// ---------------------------------------------------------------------

/** Documentos fica fora desta entrega (registrado em docs/decisoes/conversas-painel-caso.md). */
export const CASE_TABS = ["resumo", "tarefas", "historico"] as const;
export type CaseTab = (typeof CASE_TABS)[number];

export const CASE_TAB_LABEL: Record<CaseTab, string> = {
  resumo: "Resumo",
  tarefas: "Tarefas",
  historico: "Histórico",
};

export function isCaseTab(v: unknown): v is CaseTab {
  return typeof v === "string" && (CASE_TABS as readonly string[]).includes(v);
}

/** Texto do chip de vários casos: "2 casos". */
export function caseCountLabel(n: number): string {
  return n === 1 ? "1 caso" : `${n} casos`;
}
