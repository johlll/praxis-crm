"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { toUserMessage } from "@/lib/errors";

import {
  applyPlanSchema,
  archiveServiceTypeSchema,
  assignCaseNumberSchema,
  completeStepSchema,
  removePlanSchema,
  reopenStepSchema,
  serviceTypeFormSchema,
  setCurrentStepSchema,
} from "./schema";

/**
 * Painel do caso, etapa B — escritas HUMANAS do número interno, do roteiro do caso e do catálogo
 * (docs/decisoes/conversas-painel-servico.md). Nenhuma delas envia mensagem, chama serviço externo, cria
 * atividade ou muda a situação do atendimento ou a etapa comercial. A permissão é conferida aqui e de novo
 * no banco, com o alcance do registro; o banco também confere a versão da trilha e a chave de idempotência.
 */

export type CaseServiceActionState =
  | { ok: true; result: { replayed: boolean; version: number } }
  | { ok: false; error: string; conflict?: true };

const SERVICE_TYPES_PATH = "/configuracoes/tipos-de-servico";

function firstIssue(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Dados inválidos.";
}

function failure(error: { message?: string } | null | undefined): CaseServiceActionState & { ok: false } {
  return {
    ok: false,
    error: toUserMessage(error),
    ...(error?.message === "track_conflict" ? { conflict: true as const } : {}),
  };
}

function revalidateCase(opportunityId: string) {
  revalidatePath("/conversas", "layout");
  revalidatePath(`/oportunidades/${opportunityId}`);
}

function done(opportunityId: string, data: unknown): CaseServiceActionState {
  const row = (data ?? {}) as Record<string, unknown>;
  revalidateCase(opportunityId);
  return { ok: true, result: { replayed: row.replayed === true, version: Number(row.version ?? 0) } };
}

/** Atribui o próximo número interno a um caso sem número (aberto ou ganho). Repetir não gasta outro número. */
export async function assignCaseNumberAction(input: { opportunityId: string }): Promise<CaseServiceActionState> {
  const guard = await requirePermissionSafe("case.number_assign");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = assignCaseNumberSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("assign_opportunity_case_number", { p_opportunity_id: parsed.data.opportunityId });
  if (error || !data) return failure(error);
  const row = data as Record<string, unknown>;
  revalidateCase(parsed.data.opportunityId);
  return { ok: true, result: { replayed: row.assigned_now !== true, version: 0 } };
}

/** Aplica (sem roteiro) ou troca (com roteiro) o tipo de serviço do caso. */
export async function applyCaseServicePlanAction(
  input: {
    opportunityId: string;
    serviceTypeId: string;
    expectedVersion: number;
    currentStepPosition?: number | null;
    acknowledgeRecords?: boolean;
    idempotencyKey?: string;
  },
  mode: "apply" | "replace",
): Promise<CaseServiceActionState> {
  const guard = await requirePermissionSafe("case.progress_edit");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = applyPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };
  const d = parsed.data;

  const supabase = await createServerSupabaseClient();
  const common = {
    p_opportunity_id: d.opportunityId,
    p_service_type_id: d.serviceTypeId,
    p_expected_version: d.expectedVersion,
    ...(d.currentStepPosition !== null ? { p_current_step_position: d.currentStepPosition } : {}),
    ...(d.idempotencyKey ? { p_idempotency_key: d.idempotencyKey } : {}),
  };
  const { data, error } =
    mode === "apply"
      ? await supabase.rpc("apply_case_service_plan", common)
      : await supabase.rpc("replace_case_service_plan", { ...common, p_acknowledge_records: d.acknowledgeRecords });
  if (error || !data) return failure(error);
  return done(d.opportunityId, data);
}

export async function removeCaseServicePlanAction(input: {
  opportunityId: string;
  expectedVersion: number;
  acknowledgeRecords?: boolean;
  idempotencyKey?: string;
}): Promise<CaseServiceActionState> {
  const guard = await requirePermissionSafe("case.progress_edit");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = removePlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };
  const d = parsed.data;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("remove_case_service_plan", {
    p_opportunity_id: d.opportunityId,
    p_expected_version: d.expectedVersion,
    p_acknowledge_records: d.acknowledgeRecords,
    ...(d.idempotencyKey ? { p_idempotency_key: d.idempotencyKey } : {}),
  });
  if (error || !data) return failure(error);
  return done(d.opportunityId, data);
}

export async function completeCaseServiceStepAction(input: {
  opportunityId: string;
  stepId: string;
  expectedVersion: number;
  nextCurrentStepId?: string | null;
  idempotencyKey?: string;
}): Promise<CaseServiceActionState> {
  const guard = await requirePermissionSafe("case.progress_edit");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = completeStepSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };
  const d = parsed.data;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("complete_case_service_step", {
    p_opportunity_id: d.opportunityId,
    p_step_id: d.stepId,
    p_expected_version: d.expectedVersion,
    ...(d.nextCurrentStepId ? { p_next_current_step_id: d.nextCurrentStepId } : {}),
    ...(d.idempotencyKey ? { p_idempotency_key: d.idempotencyKey } : {}),
  });
  if (error || !data) return failure(error);
  return done(d.opportunityId, data);
}

export async function reopenCaseServiceStepAction(input: {
  opportunityId: string;
  stepId: string;
  expectedVersion: number;
  makeCurrent?: boolean;
  progressStatus?: string | null;
  idempotencyKey?: string;
}): Promise<CaseServiceActionState> {
  const guard = await requirePermissionSafe("case.progress_edit");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = reopenStepSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };
  const d = parsed.data;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("reopen_case_service_step", {
    p_opportunity_id: d.opportunityId,
    p_step_id: d.stepId,
    p_expected_version: d.expectedVersion,
    p_make_current: d.makeCurrent,
    ...(d.progressStatus ? { p_progress_status: d.progressStatus } : {}),
    ...(d.idempotencyKey ? { p_idempotency_key: d.idempotencyKey } : {}),
  });
  if (error || !data) return failure(error);
  return done(d.opportunityId, data);
}

export async function setCaseServiceCurrentStepAction(input: {
  opportunityId: string;
  stepId: string | null;
  expectedVersion: number;
  idempotencyKey?: string;
}): Promise<CaseServiceActionState> {
  const guard = await requirePermissionSafe("case.progress_edit");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = setCurrentStepSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };
  const d = parsed.data;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("set_case_service_current_step", {
    p_opportunity_id: d.opportunityId,
    // Nulo limpa a etapa atual (o tipo gerado não aceita null; o banco aceita).
    p_step_id: d.stepId as string,
    p_expected_version: d.expectedVersion,
    ...(d.idempotencyKey ? { p_idempotency_key: d.idempotencyKey } : {}),
  });
  if (error || !data) return failure(error);
  return done(d.opportunityId, data);
}

// ---------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------

export type ServiceTypeActionState = { ok: true } | { ok: false; error: string };

/** Cria (sem `serviceTypeId`) ou edita um tipo de serviço. Editar nunca muda os casos que já o aplicaram. */
export async function saveServiceTypeAction(input: {
  serviceTypeId?: string | null;
  expectedVersion?: number | null;
  name: string;
  steps: string[];
  suggestionCode?: string | null;
}): Promise<ServiceTypeActionState> {
  const guard = await requirePermissionSafe("service_catalog.manage");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = serviceTypeFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };
  const d = parsed.data;

  const supabase = await createServerSupabaseClient();
  const { error } = d.serviceTypeId
    ? await supabase.rpc("update_service_type", {
        p_service_type_id: d.serviceTypeId,
        p_name: d.name,
        p_steps: d.steps,
        p_expected_version: d.expectedVersion as number,
      })
    : await supabase.rpc("create_service_type", {
        p_workspace_id: guard.ctx.workspaceId,
        p_name: d.name,
        p_steps: d.steps,
        ...(d.suggestionCode ? { p_suggestion_code: d.suggestionCode } : {}),
      });
  if (error) return { ok: false, error: toUserMessage(error) };
  revalidatePath(SERVICE_TYPES_PATH);
  return { ok: true };
}

export async function setServiceTypeArchivedAction(input: {
  serviceTypeId: string;
  archived: boolean;
  expectedVersion: number;
}): Promise<ServiceTypeActionState> {
  const guard = await requirePermissionSafe("service_catalog.manage");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = archiveServiceTypeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_service_type_archived", {
    p_service_type_id: parsed.data.serviceTypeId,
    p_archived: parsed.data.archived,
    p_expected_version: parsed.data.expectedVersion,
  });
  if (error) return { ok: false, error: toUserMessage(error) };
  revalidatePath(SERVICE_TYPES_PATH);
  return { ok: true };
}
