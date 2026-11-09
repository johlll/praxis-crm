import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { LEAD_PRIORITIES } from "@/modules/leads/schema";

/**
 * Automações internas (C1 mínima). Estrutura FECHADA: gatilhos, condições,
 * ação, estados e códigos de erro são listas fixas — não existe campo livre,
 * expressão, SQL ou JavaScript. O banco repete cada regra (CHECKs e a função
 * de validação); isto é a primeira barreira e a fonte dos rótulos da tela.
 */

export const AUTOMATION_PATH = "/automacoes";

export const AUTOMATION_TRIGGERS = ["lead_created", "opportunity_stage_changed"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const AUTOMATION_ASSIGNEE_MODES = ["lead_owner", "user"] as const;
export type AutomationAssigneeMode = (typeof AUTOMATION_ASSIGNEE_MODES)[number];

export const AUTOMATION_EXECUTION_STATES = ["pending", "succeeded", "cancelled", "dead_letter"] as const;
export type AutomationExecutionState = (typeof AUTOMATION_EXECUTION_STATES)[number];

/** Só estes códigos existem (o banco os impõe por CHECK): nunca texto livre. */
export const AUTOMATION_ERROR_CODES = [
  "assignee_not_member",
  "assignee_no_access",
  "target_not_found",
  "rule_inactive",
  "rule_changed",
  "unexpected_error",
] as const;
export type AutomationErrorCode = (typeof AUTOMATION_ERROR_CODES)[number];

/** Tentativas por execução (a 4ª falha leva a dead-letter). Igual ao banco. */
export const AUTOMATION_MAX_ATTEMPTS = 4;
export const AUTOMATION_SIMULATION_WINDOW_DAYS = 30;

export const AUTOMATION_TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  lead_created: "Lead criado",
  opportunity_stage_changed: "Oportunidade mudou de etapa",
};

export const AUTOMATION_STATUS_LABEL: Record<AutomationStatus, string> = {
  draft: "Rascunho",
  active: "Ativa",
  paused: "Pausada",
  archived: "Arquivada",
};

export const AUTOMATION_ASSIGNEE_MODE_LABEL: Record<AutomationAssigneeMode, string> = {
  lead_owner: "Responsável atual do lead",
  user: "Pessoa específica",
};

export const AUTOMATION_EXECUTION_STATE_LABEL: Record<AutomationExecutionState, string> = {
  pending: "Aguardando",
  succeeded: "Concluída",
  cancelled: "Cancelada",
  dead_letter: "Falhou (sem novas tentativas)",
};

/** Texto de cada código sanitizado. Um código desconhecido cai no genérico. */
export const AUTOMATION_ERROR_LABEL: Record<AutomationErrorCode, string> = {
  assignee_not_member: "O responsável não é mais um membro ativo do workspace.",
  assignee_no_access: "O responsável não tem acesso a este lead.",
  target_not_found: "O lead ou a oportunidade não existe mais.",
  rule_inactive: "A regra foi pausada ou arquivada antes da execução.",
  rule_changed: "A regra foi alterada antes da execução.",
  unexpected_error: "Erro inesperado. Uma nova tentativa será feita, se ainda houver.",
};

export function automationErrorLabel(code: string | null): string | null {
  if (code === null) return null;
  return (AUTOMATION_ERROR_LABEL as Record<string, string>)[code] ?? AUTOMATION_ERROR_LABEL.unexpected_error;
}

// ---------------------------------------------------------------------
// Formulário da regra (criar/editar)
// ---------------------------------------------------------------------

const emptyToUndefined = (value: unknown) => (value === "" || value === null ? undefined : value);

export const automationRuleFormSchema = z
  .object({
    ruleId: z.preprocess(emptyToUndefined, uuidSchema.optional()),
    name: z.string().trim().min(1, "Informe o nome da regra.").max(120, "O nome pode ter até 120 caracteres."),
    trigger: z.enum(AUTOMATION_TRIGGERS, { message: "Escolha o gatilho." }),
    condPriority: z.preprocess(emptyToUndefined, z.enum(LEAD_PRIORITIES).optional()),
    condLegalArea: z.preprocess(
      emptyToUndefined,
      z.string().trim().min(1).max(120, "A área pode ter até 120 caracteres.").optional(),
    ),
    condToStageId: z.preprocess(emptyToUndefined, uuidSchema.optional()),
    condFromStageId: z.preprocess(emptyToUndefined, uuidSchema.optional()),
    actionTitle: z
      .string()
      .trim()
      .min(1, "Informe o título da atividade.")
      .max(160, "O título pode ter até 160 caracteres."),
    actionDueDays: z
      .string()
      .trim()
      .regex(/^\d{1,3}$/, "Informe o prazo em dias (0 a 90).")
      .transform(Number)
      .pipe(z.number().int().min(0, "Informe o prazo em dias (0 a 90).").max(90, "O prazo máximo é de 90 dias.")),
    actionPriority: z.enum(LEAD_PRIORITIES, { message: "Escolha a prioridade." }),
    assigneeMode: z.enum(AUTOMATION_ASSIGNEE_MODES, { message: "Escolha o responsável." }),
    assigneeUserId: z.preprocess(emptyToUndefined, uuidSchema.optional()),
  })
  .superRefine((value, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });

    if (value.trigger === "lead_created") {
      if (value.condToStageId || value.condFromStageId) {
        fail("condToStageId", "Condição de etapa não vale para o gatilho de lead criado.");
      }
    } else {
      if (!value.condToStageId) fail("condToStageId", "Escolha a etapa de destino.");
      if (value.condPriority || value.condLegalArea) {
        fail("condPriority", "Prioridade e área não são condições do gatilho de etapa.");
      }
    }

    if (value.assigneeMode === "user" && !value.assigneeUserId) {
      fail("assigneeUserId", "Escolha a pessoa responsável.");
    }
    if (value.assigneeMode === "lead_owner" && value.assigneeUserId) {
      fail("assigneeUserId", "Não escolha uma pessoa quando o responsável for o do lead.");
    }
  });

export type AutomationRuleForm = z.output<typeof automationRuleFormSchema>;

/** Parâmetros da RPC (o `workspace` ou o `rule_id` entram por fora). */
export function ruleRpcArgs(form: AutomationRuleForm) {
  return {
    p_name: form.name,
    p_trigger_type: form.trigger,
    p_action_title: form.actionTitle,
    p_action_due_days: form.actionDueDays,
    p_action_priority: form.actionPriority,
    p_action_assignee_mode: form.assigneeMode,
    ...(form.assigneeUserId ? { p_action_assignee_user_id: form.assigneeUserId } : {}),
    ...(form.condPriority ? { p_cond_priority: form.condPriority } : {}),
    ...(form.condLegalArea ? { p_cond_legal_area: form.condLegalArea } : {}),
    ...(form.condToStageId ? { p_cond_to_stage_id: form.condToStageId } : {}),
    ...(form.condFromStageId ? { p_cond_from_stage_id: form.condFromStageId } : {}),
  };
}

// ---------------------------------------------------------------------
// Linhas devolvidas pelas RPCs (validadas de novo no servidor Next)
// ---------------------------------------------------------------------

export const automationRuleRowSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  status: z.enum(AUTOMATION_STATUSES),
  trigger_type: z.enum(AUTOMATION_TRIGGERS),
  cond_priority: z.enum(LEAD_PRIORITIES).nullable(),
  cond_legal_area: z.string().nullable(),
  cond_to_stage_id: uuidSchema.nullable(),
  cond_from_stage_id: uuidSchema.nullable(),
  action_title: z.string(),
  action_due_days: z.number().int(),
  action_priority: z.enum(LEAD_PRIORITIES),
  action_assignee_mode: z.enum(AUTOMATION_ASSIGNEE_MODES),
  action_assignee_user_id: uuidSchema.nullable(),
  version: z.number().int(),
  simulation_current: z.boolean(),
  simulated_at: z.string().nullable(),
  simulated_count: z.number().int().nullable(),
  activated_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const automationExecutionRowSchema = z.object({
  id: uuidSchema,
  rule_id: uuidSchema,
  rule_name: z.string(),
  event_type: z.enum(AUTOMATION_TRIGGERS),
  state: z.enum(AUTOMATION_EXECUTION_STATES),
  attempt_count: z.number().int().min(0),
  last_attempt_at: z.string().nullable(),
  next_attempt_at: z.string().nullable(),
  // Texto livre NUNCA chega até aqui: o que não for código conhecido é descartado.
  error_code: z.preprocess(
    (value) => (typeof value === "string" && (AUTOMATION_ERROR_CODES as readonly string[]).includes(value) ? value : value === null ? null : "unexpected_error"),
    z.enum(AUTOMATION_ERROR_CODES).nullable(),
  ),
  activity_id: uuidSchema.nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});

export const automationSimulationSchema = z.object({
  version: z.number().int(),
  window_days: z.number().int(),
  match_count: z.number().int().min(0),
  sample: z.array(
    z.object({
      date: z.string(),
      priority: z.enum(LEAD_PRIORITIES),
      legal_area: z.string().nullable(),
      due_date: z.string(),
      assignee: z.enum(["ok", "none", "invalid"]),
    }),
  ),
  sample_invalid: z.number().int().min(0),
});

export type AutomationSimulation = z.output<typeof automationSimulationSchema>;
