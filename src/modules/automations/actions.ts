"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { toUserMessage } from "@/lib/errors";
import { uuidSchema } from "@/lib/uuid";
import {
  AUTOMATION_PATH,
  automationRuleFormSchema,
  automationSimulationSchema,
  ruleRpcArgs,
  type AutomationSimulation,
} from "./schema";

/**
 * Server Actions das automações (C1). Toda ação exige `automation.manage`
 * (owner e admin); o workspace vem SEMPRE da sessão, nunca do formulário; e o
 * banco repete a autorização. Erros voltam sanitizados (toUserMessage): nada
 * do texto do banco chega à tela.
 */

const GENERIC_ERROR = "Não foi possível concluir a operação. Tente novamente.";

export type SaveAutomationRuleResult = { ok: true; ruleId: string } | { ok: false; error: string };

export async function saveAutomationRuleAction(formData: FormData): Promise<SaveAutomationRuleResult> {
  const guard = await requirePermissionSafe("automation.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = automationRuleFormSchema.safeParse({
    ruleId: formData.get("ruleId") ?? "",
    name: formData.get("name") ?? "",
    trigger: formData.get("trigger") ?? "",
    condPriority: formData.get("condPriority") ?? "",
    condLegalArea: formData.get("condLegalArea") ?? "",
    condToStageId: formData.get("condToStageId") ?? "",
    condFromStageId: formData.get("condFromStageId") ?? "",
    actionTitle: formData.get("actionTitle") ?? "",
    actionDueDays: formData.get("actionDueDays") ?? "",
    actionPriority: formData.get("actionPriority") ?? "",
    assigneeMode: formData.get("assigneeMode") ?? "",
    assigneeUserId: formData.get("assigneeUserId") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const form = parsed.data;
  const supabase = await createServerSupabaseClient();

  if (form.ruleId) {
    const { error } = await supabase.rpc("update_automation_rule", { p_rule_id: form.ruleId, ...ruleRpcArgs(form) });
    if (error) return { ok: false, error: toUserMessage(error) };
    revalidatePath(AUTOMATION_PATH);
    return { ok: true, ruleId: form.ruleId };
  }

  const { data, error } = await supabase.rpc("create_automation_rule", {
    p_workspace_id: guard.ctx.workspaceId,
    ...ruleRpcArgs(form),
  });
  if (error || !data) return { ok: false, error: toUserMessage(error) };
  revalidatePath(AUTOMATION_PATH);
  return { ok: true, ruleId: data };
}

export type SimulateAutomationRuleResult =
  | { ok: true; simulation: AutomationSimulation }
  | { ok: false; error: string };

/** Só lê e carimba a versão simulada na regra; não grava atividade nem toca em lead ou oportunidade. */
export async function simulateAutomationRuleAction(ruleId: string): Promise<SimulateAutomationRuleResult> {
  const guard = await requirePermissionSafe("automation.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const id = uuidSchema.safeParse(ruleId);
  if (!id.success) return { ok: false, error: "Regra não encontrada." };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("simulate_automation_rule", { p_rule_id: id.data });
  if (error) return { ok: false, error: toUserMessage(error) };

  const simulation = automationSimulationSchema.safeParse(data);
  if (!simulation.success) return { ok: false, error: GENERIC_ERROR };

  revalidatePath(AUTOMATION_PATH);
  return { ok: true, simulation: simulation.data };
}

const nextStatusSchema = z.enum(["active", "paused", "archived"]);

export async function setAutomationRuleStatusAction(
  ruleId: string,
  status: "active" | "paused" | "archived",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const guard = await requirePermissionSafe("automation.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const id = uuidSchema.safeParse(ruleId);
  const next = nextStatusSchema.safeParse(status);
  if (!id.success || !next.success) return { ok: false, error: "Dados inválidos." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_automation_rule_status", { p_rule_id: id.data, p_status: next.data });
  if (error) return { ok: false, error: toUserMessage(error) };

  revalidatePath(AUTOMATION_PATH);
  return { ok: true };
}

export type ProcessAutomationsResult =
  | { ok: true; events: number; executions: number }
  | { ok: false; error: string };

/**
 * "Processar agora": roda uma rodada do workspace (eventos pendentes e
 * tentativas vencidas). Idempotente — processar de novo nunca duplica nada.
 */
export async function processAutomationsAction(): Promise<ProcessAutomationsResult> {
  const guard = await requirePermissionSafe("automation.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("process_automation_events", {
    p_workspace_id: guard.ctx.workspaceId,
    p_limit: 50,
  });
  if (error) return { ok: false, error: toUserMessage(error) };

  const result = z.object({ events: z.number().int(), executions: z.number().int() }).safeParse(data);
  if (!result.success) return { ok: false, error: GENERIC_ERROR };

  revalidatePath(AUTOMATION_PATH);
  revalidatePath("/atividades");
  return { ok: true, events: result.data.events, executions: result.data.executions };
}
