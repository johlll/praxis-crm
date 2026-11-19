import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { CASE_PROGRESS_STATUSES, type CaseProgressStatus } from "@/modules/status-tracks/schema";

/**
 * Painel do caso, etapa B — número interno do caso, tipos de serviço e roteiro com marcos concluídos
 * (docs/decisoes/conversas-painel-servico.md). Módulo PURO (sem banco e sem `server-only`): tipos, modelos
 * sugeridos, validação e regras de exibição valem no servidor e no navegador e são testados sem rede.
 */

// ---------------------------------------------------------------------
// Número interno
// ---------------------------------------------------------------------

/** "#0042": número interno do escritório, NUNCA o número do processo judicial. */
export function formatCaseNumber(n: number): string {
  return `#${String(n).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------
// Limites (o banco repete)
// ---------------------------------------------------------------------

export const SERVICE_TYPE_NAME_MAX = 80;
export const SERVICE_STEP_NAME_MAX = 80;
export const SERVICE_STEPS_MAX = 30;
/** Até este número de etapas o andamento usa a faixa horizontal da referência; acima, lista vertical. */
export const SERVICE_HORIZONTAL_MAX = 4;

// ---------------------------------------------------------------------
// Modelos sugeridos (só entram no catálogo por escolha explícita, como cópia editável)
// ---------------------------------------------------------------------

export type ServiceTypeSuggestion = {
  code: string;
  name: string;
  description: string;
  steps: readonly string[];
};

/**
 * Base inicial do produto para o escritório COPIAR e ajustar — não é validação jurídica. Serviços
 * extrajudiciais e consultivos não têm protocolo de ação nem sentença. Nada disso é aplicado sozinho.
 */
export const SERVICE_TYPE_SUGGESTIONS: readonly ServiceTypeSuggestion[] = [
  {
    code: "processo_judicial",
    name: "Processo judicial",
    description: "Ação na Justiça, do preparo ao encerramento.",
    steps: ["Documentos reunidos", "Análise do caso", "Petição inicial protocolada", "Acompanhamento do processo", "Encerramento"],
  },
  {
    code: "procedimento_extrajudicial",
    name: "Procedimento extrajudicial",
    description: "Pedido em cartório ou órgão administrativo, sem ação judicial.",
    steps: ["Documentos reunidos", "Análise documental", "Elaboração do pedido", "Encaminhamento ao cartório ou órgão", "Conclusão"],
  },
  {
    code: "consultoria_parecer",
    name: "Consultoria ou parecer",
    description: "Orientação jurídica com entrega de parecer.",
    steps: ["Recebimento das informações", "Análise", "Parecer entregue"],
  },
  {
    code: "contrato_documento",
    name: "Contrato ou documento",
    description: "Redação ou revisão de contrato e outros documentos.",
    steps: ["Levantamento das informações", "Minuta", "Revisão com o cliente", "Versão final entregue"],
  },
];

export function findSuggestion(code: string): ServiceTypeSuggestion | null {
  return SERVICE_TYPE_SUGGESTIONS.find((s) => s.code === code) ?? null;
}

// ---------------------------------------------------------------------
// Tipos lidos do banco (mapeadores puros: o servidor usa, o navegador só recebe os tipos)
// ---------------------------------------------------------------------

export type CaseNumberInfo = {
  number: number;
  assignedVia: "manual" | "win";
  assignedAt: string;
  assignedByName: string | null;
};

export type CaseServiceStep = {
  id: string;
  position: number;
  name: string;
  completedAt: string | null;
  completedByName: string | null;
};

export type CaseServicePlan = {
  id: string;
  serviceTypeId: string | null;
  serviceTypeName: string;
  /** Versão do modelo COPIADA quando o roteiro foi aplicado. */
  serviceTypeVersion: number;
  templateName: string | null;
  /** Versão atual do modelo (pode ser mais nova que a aplicada: o caso não muda sozinho). */
  templateVersion: number | null;
  templateArchived: boolean;
  appliedAt: string;
  appliedByName: string | null;
  currentStepId: string | null;
  /** Já houve conclusão registrada neste roteiro (trocar ou remover exige confirmação). */
  hasRecords: boolean;
  steps: CaseServiceStep[];
};

export type CaseService = {
  opportunityId: string;
  opportunityStatus: "open" | "won" | "lost";
  /** Roteiro e andamento só existem para oportunidade ganha. */
  applicable: boolean;
  caseNumber: CaseNumberInfo | null;
  /** Versão da trilha case_progress: UMA só para o andamento e o roteiro. */
  version: number;
  status: CaseProgressStatus | null;
  automationPaused: boolean;
  manualDecidedAt: string | null;
  plan: CaseServicePlan | null;
  previousPlans: number;
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function mapCaseService(row: Record<string, unknown>): CaseService {
  const n = row.case_number as Record<string, unknown> | null;
  const p = row.plan as Record<string, unknown> | null;
  return {
    opportunityId: row.opportunity_id as string,
    opportunityStatus: row.opportunity_status as CaseService["opportunityStatus"],
    applicable: row.applicable === true,
    caseNumber: n
      ? {
          number: Number(n.number),
          assignedVia: n.assigned_via === "win" ? "win" : "manual",
          assignedAt: n.assigned_at as string,
          assignedByName: str(n.assigned_by_name),
        }
      : null,
    version: Number(row.version ?? 0),
    status: (str(row.status) as CaseProgressStatus | null) ?? null,
    automationPaused: row.automation_paused === true,
    manualDecidedAt: str(row.manual_decided_at),
    plan: p
      ? {
          id: p.id as string,
          serviceTypeId: str(p.service_type_id),
          serviceTypeName: p.service_type_name as string,
          serviceTypeVersion: Number(p.service_type_version),
          templateName: str(p.template_name),
          templateVersion: p.template_version == null ? null : Number(p.template_version),
          templateArchived: p.template_archived === true,
          appliedAt: p.applied_at as string,
          appliedByName: str(p.applied_by_name),
          currentStepId: str(p.current_step_id),
          hasRecords: p.has_records === true,
          steps: (Array.isArray(p.steps) ? (p.steps as Record<string, unknown>[]) : []).map((s) => ({
            id: s.id as string,
            position: Number(s.position),
            name: s.name as string,
            completedAt: str(s.completed_at),
            completedByName: str(s.completed_by_name),
          })),
        }
      : null,
    previousPlans: Number(row.previous_plans ?? 0),
  };
}

export const CASE_SERVICE_OPS = [
  "plan_applied",
  "plan_replaced",
  "plan_removed",
  "step_completed",
  "step_reopened",
  "current_step_set",
  "current_step_cleared",
] as const;
export type CaseServiceOp = (typeof CASE_SERVICE_OPS)[number];

export type CaseServiceEvent = {
  id: string;
  op: CaseServiceOp;
  planName: string | null;
  previousPlanName: string | null;
  stepName: string | null;
  stepPosition: number | null;
  currentBeforeName: string | null;
  currentAfterName: string | null;
  progressFrom: CaseProgressStatus | null;
  progressTo: CaseProgressStatus | null;
  toVersion: number;
  actorName: string | null;
  occurredAt: string;
};

export function mapCaseServiceEvent(row: Record<string, unknown>): CaseServiceEvent {
  return {
    id: row.id as string,
    op: row.op as CaseServiceOp,
    planName: str(row.plan_name),
    previousPlanName: str(row.previous_plan_name),
    stepName: str(row.step_name),
    stepPosition: row.step_position == null ? null : Number(row.step_position),
    currentBeforeName: str(row.current_step_before_name),
    currentAfterName: str(row.current_step_after_name),
    progressFrom: (str(row.progress_from) as CaseProgressStatus | null) ?? null,
    progressTo: (str(row.progress_to) as CaseProgressStatus | null) ?? null,
    toVersion: Number(row.to_version),
    actorName: str(row.actor_name),
    occurredAt: row.occurred_at as string,
  };
}

export type ServiceTypeItem = {
  id: string;
  name: string;
  version: number;
  suggestionCode: string | null;
  archived: boolean;
  steps: { position: number; name: string }[];
  /** Quantos casos usam o tipo hoje (roteiro ativo). */
  activeCases: number;
};

export function mapServiceType(row: Record<string, unknown>): ServiceTypeItem {
  return {
    id: row.id as string,
    name: row.name as string,
    version: Number(row.version),
    suggestionCode: str(row.suggestion_code),
    archived: row.archived === true,
    steps: (Array.isArray(row.steps) ? (row.steps as Record<string, unknown>[]) : []).map((s) => ({
      position: Number(s.position),
      name: s.name as string,
    })),
    activeCases: Number(row.active_cases ?? 0),
  };
}

// ---------------------------------------------------------------------
// Regras de exibição do roteiro
// ---------------------------------------------------------------------

/**
 * Estado de cada etapa, SÓ pelo que está gravado: `completed` tem conclusão registrada; `current` é a etapa
 * atual escolhida; o resto é `pending`. A posição nunca vira conclusão.
 */
export type ServiceStepState = "completed" | "current" | "pending";

export type ServiceStepItem = CaseServiceStep & { state: ServiceStepState };

export function serviceStepItems(plan: Pick<CaseServicePlan, "steps" | "currentStepId">): ServiceStepItem[] {
  return [...plan.steps]
    .sort((a, b) => a.position - b.position)
    .map((s) => ({
      ...s,
      state: s.completedAt ? "completed" : s.id === plan.currentStepId ? "current" : "pending",
    }));
}

/** Próxima etapa PENDENTE depois de `stepId`, na ordem (sugestão do "concluir e avançar"; nunca automática). */
export function nextPendingAfter(plan: Pick<CaseServicePlan, "steps">, stepId: string): CaseServiceStep | null {
  const ordered = [...plan.steps].sort((a, b) => a.position - b.position);
  const idx = ordered.findIndex((s) => s.id === stepId);
  if (idx < 0) return null;
  return ordered.slice(idx + 1).find((s) => !s.completedAt) ?? null;
}

export function serviceProgressCounts(plan: Pick<CaseServicePlan, "steps" | "currentStepId">): {
  total: number;
  completed: number;
  current: CaseServiceStep | null;
} {
  return {
    total: plan.steps.length,
    completed: plan.steps.filter((s) => s.completedAt).length,
    current: plan.steps.find((s) => s.id === plan.currentStepId) ?? null,
  };
}

/** Texto do evento do roteiro no Histórico (o alvo sempre com o nome da etapa copiada). */
export function serviceEventText(e: CaseServiceEvent): string {
  const step = e.stepName ? `“${e.stepName}”` : "etapa";
  switch (e.op) {
    case "plan_applied":
      return `Roteiro aplicado: ${e.planName ?? "tipo de serviço"}${e.currentAfterName ? ` (etapa atual: ${e.currentAfterName})` : ""}`;
    case "plan_replaced":
      return `Roteiro trocado: ${e.previousPlanName ?? "anterior"} → ${e.planName ?? "novo"} (o anterior fica no histórico)`;
    case "plan_removed":
      return `Roteiro removido: ${e.planName ?? "tipo de serviço"} (as conclusões ficam no histórico)`;
    case "step_completed":
      return `Etapa concluída: ${step}${e.currentAfterName && e.currentAfterName !== e.currentBeforeName ? ` · etapa atual: ${e.currentAfterName}` : ""}`;
    case "step_reopened":
      return `Etapa reaberta: ${step}${e.currentAfterName && e.currentAfterName !== e.currentBeforeName ? " · voltou a ser a etapa atual" : ""}`;
    case "current_step_set":
      return `Etapa atual: ${e.currentAfterName ?? "—"}${e.currentBeforeName ? ` (antes: ${e.currentBeforeName})` : ""}`;
    case "current_step_cleared":
      return `Sem etapa atual${e.currentBeforeName ? ` (antes: ${e.currentBeforeName})` : ""}`;
  }
}

// ---------------------------------------------------------------------
// Validação das ações (o banco repete tudo)
// ---------------------------------------------------------------------

const id = (message: string) => z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message);
const version = z.number({ message: "Recarregue a página e tente de novo." }).int().min(0);
const idempotencyKey = uuidSchema.optional();

export const assignCaseNumberSchema = z.object({ opportunityId: id("Caso inválido.") });

export const applyPlanSchema = z.object({
  opportunityId: id("Caso inválido."),
  serviceTypeId: id("Escolha um tipo de serviço."),
  expectedVersion: version,
  currentStepPosition: z.number().int().min(1).max(SERVICE_STEPS_MAX).nullable().default(null),
  acknowledgeRecords: z.boolean().default(false),
  idempotencyKey,
});

export const removePlanSchema = z.object({
  opportunityId: id("Caso inválido."),
  expectedVersion: version,
  acknowledgeRecords: z.boolean().default(false),
  idempotencyKey,
});

export const completeStepSchema = z.object({
  opportunityId: id("Caso inválido."),
  stepId: id("Etapa inválida."),
  expectedVersion: version,
  nextCurrentStepId: id("Etapa inválida.").nullable().default(null),
  idempotencyKey,
});

const reopenStatus = z
  .enum(CASE_PROGRESS_STATUSES)
  .refine((s) => s !== "nao_informado" && s !== "concluido", { message: "Escolha o novo andamento do serviço." });

export const reopenStepSchema = z.object({
  opportunityId: id("Caso inválido."),
  stepId: id("Etapa inválida."),
  expectedVersion: version,
  makeCurrent: z.boolean().default(false),
  progressStatus: reopenStatus.nullable().default(null),
  idempotencyKey,
});

export const setCurrentStepSchema = z.object({
  opportunityId: id("Caso inválido."),
  stepId: id("Etapa inválida.").nullable(),
  expectedVersion: version,
  idempotencyKey,
});

const stepName = z
  .string()
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1, "Toda etapa precisa de nome.").max(SERVICE_STEP_NAME_MAX, `Cada etapa tem até ${SERVICE_STEP_NAME_MAX} caracteres.`));

export const serviceTypeFormSchema = z
  .object({
    serviceTypeId: id("Tipo inválido.").nullable().default(null),
    expectedVersion: z.number().int().min(1).nullable().default(null),
    name: z
      .string()
      .transform((s) => s.replace(/\s+/g, " ").trim())
      .pipe(z.string().min(1, "Informe o nome do tipo de serviço.").max(SERVICE_TYPE_NAME_MAX, `O nome tem até ${SERVICE_TYPE_NAME_MAX} caracteres.`)),
    steps: z
      .array(stepName)
      .min(1, "Inclua ao menos uma etapa.")
      .max(SERVICE_STEPS_MAX, `No máximo ${SERVICE_STEPS_MAX} etapas.`)
      .refine((steps) => new Set(steps.map((s) => s.toLowerCase())).size === steps.length, { message: "Há etapas com o mesmo nome." }),
    suggestionCode: z.string().regex(/^[a-z0-9_]{1,40}$/).nullable().default(null),
  })
  .refine((v) => (v.serviceTypeId === null) === (v.expectedVersion === null), { message: "Recarregue a página e tente de novo." });

export const archiveServiceTypeSchema = z.object({
  serviceTypeId: id("Tipo inválido."),
  archived: z.boolean(),
  expectedVersion: z.number().int().min(1),
});
