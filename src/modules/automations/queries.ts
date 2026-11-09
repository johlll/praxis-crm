import { z } from "zod";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError, isExpectedAbsence } from "@/server/data/load-error";
import {
  automationExecutionRowSchema,
  automationRuleRowSchema,
  type AutomationErrorCode,
  type AutomationExecutionState,
  type AutomationAssigneeMode,
  type AutomationStatus,
  type AutomationTrigger,
} from "./schema";
import type { LeadPriority } from "@/modules/leads/queries";

/**
 * Leitura das automações (C1). Passa SÓ pelas RPCs `list_automation_rules` e
 * `list_automation_executions` (owner, admin e manager): as tabelas não têm
 * grant para o cliente. O banco devolve configuração e códigos fechados —
 * nunca dado de lead, contato ou conversa —, e esta camada valida o formato
 * de novo.
 *
 * Contrato de erro (docs/decisoes/estabilizacao-pos-a9.md §1):
 *  - `insufficient_permission` (inclusive workspace alheio) → `null`: a página
 *    responde "não encontrado";
 *  - qualquer outra falha, ou linha fora do formato → DataLoadError. Nunca
 *    vira lista vazia.
 */

export class AutomationLoadError extends DataLoadError {}

export type AutomationRule = {
  id: string;
  name: string;
  status: AutomationStatus;
  trigger: AutomationTrigger;
  condPriority: LeadPriority | null;
  condLegalArea: string | null;
  condToStageId: string | null;
  condFromStageId: string | null;
  actionTitle: string;
  actionDueDays: number;
  actionPriority: LeadPriority;
  assigneeMode: AutomationAssigneeMode;
  assigneeUserId: string | null;
  version: number;
  simulationCurrent: boolean;
  simulatedAt: string | null;
  simulatedCount: number | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationExecution = {
  id: string;
  ruleId: string;
  ruleName: string;
  trigger: AutomationTrigger;
  state: AutomationExecutionState;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  errorCode: AutomationErrorCode | null;
  activityId: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export async function listAutomationRules(workspaceId: string): Promise<AutomationRule[] | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_automation_rules", { p_workspace_id: workspaceId });

  if (error) {
    if (isExpectedAbsence(error, ["insufficient_permission"])) return null;
    throw new AutomationLoadError(`as regras de automação do workspace ${workspaceId}`, error);
  }

  const rows = z.array(automationRuleRowSchema).safeParse(data);
  if (!rows.success) {
    throw new AutomationLoadError(`as regras de automação do workspace ${workspaceId} (formato inesperado)`, rows.error);
  }

  return rows.data.map(
    (row): AutomationRule => ({
      id: row.id,
      name: row.name,
      status: row.status,
      trigger: row.trigger_type,
      condPriority: row.cond_priority,
      condLegalArea: row.cond_legal_area,
      condToStageId: row.cond_to_stage_id,
      condFromStageId: row.cond_from_stage_id,
      actionTitle: row.action_title,
      actionDueDays: row.action_due_days,
      actionPriority: row.action_priority,
      assigneeMode: row.action_assignee_mode,
      assigneeUserId: row.action_assignee_user_id,
      version: row.version,
      simulationCurrent: row.simulation_current,
      simulatedAt: row.simulated_at,
      simulatedCount: row.simulated_count,
      activatedAt: row.activated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );
}

export async function listAutomationExecutions(
  workspaceId: string,
  limit = 50,
): Promise<AutomationExecution[] | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_automation_executions", {
    p_workspace_id: workspaceId,
    p_limit: limit,
  });

  if (error) {
    if (isExpectedAbsence(error, ["insufficient_permission"])) return null;
    throw new AutomationLoadError(`o histórico de automações do workspace ${workspaceId}`, error);
  }

  const rows = z.array(automationExecutionRowSchema).safeParse(data);
  if (!rows.success) {
    throw new AutomationLoadError(
      `o histórico de automações do workspace ${workspaceId} (formato inesperado)`,
      rows.error,
    );
  }

  return rows.data.map(
    (row): AutomationExecution => ({
      id: row.id,
      ruleId: row.rule_id,
      ruleName: row.rule_name,
      trigger: row.event_type,
      state: row.state,
      attemptCount: row.attempt_count,
      lastAttemptAt: row.last_attempt_at,
      nextAttemptAt: row.next_attempt_at,
      errorCode: row.error_code,
      activityId: row.activity_id,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    }),
  );
}

export type AutomationStageOption = {
  id: string;
  /** "Etapa" (um pipeline só) ou "Pipeline · Etapa". */
  label: string;
  /** Etapa de ganho/perda: não serve de condição (a regra nunca dispararia). */
  terminal: boolean;
};

/** Etapas do workspace para os formulários e para nomear a condição da regra. */
export async function listAutomationStageOptions(workspaceId: string): Promise<AutomationStageOption[]> {
  const supabase = await createServerSupabaseClient();
  const [pipelines, stages] = await Promise.all([
    supabase
      .from("pipelines")
      .select("id, name")
      .eq("workspace_id", workspaceId)
      .order("is_default", { ascending: false })
      .order("name", { ascending: true }),
    supabase
      .from("pipeline_stages")
      .select("id, pipeline_id, name, position, is_won, is_lost")
      .eq("workspace_id", workspaceId)
      .order("position", { ascending: true }),
  ]);

  if (pipelines.error) throw new AutomationLoadError(`os pipelines do workspace ${workspaceId}`, pipelines.error);
  if (stages.error) throw new AutomationLoadError(`as etapas do workspace ${workspaceId}`, stages.error);

  const pipelineList = pipelines.data ?? [];
  const nameOf = new Map(pipelineList.map((pipeline) => [pipeline.id, pipeline.name]));
  const order = new Map(pipelineList.map((pipeline, index) => [pipeline.id, index]));
  const several = pipelineList.length > 1;

  return (stages.data ?? [])
    .slice()
    .sort(
      (a, b) =>
        (order.get(a.pipeline_id) ?? 0) - (order.get(b.pipeline_id) ?? 0) || a.position - b.position,
    )
    .map((stage) => ({
      id: stage.id,
      label: several ? `${nameOf.get(stage.pipeline_id) ?? "Pipeline"} · ${stage.name}` : stage.name,
      terminal: stage.is_won || stage.is_lost,
    }));
}
