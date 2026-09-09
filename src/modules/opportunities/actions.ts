"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermission, AuthzError, type Permission } from "@/server/authz/permissions";
import { toUserMessage } from "@/lib/errors";
import {
  createOpportunitySchema,
  moveOpportunityStageSchema,
  winOpportunitySchema,
  loseOpportunitySchema,
  createPipelineStageSchema,
  createStageRequirementSchema,
  createLostReasonSchema,
} from "./schema";
import { getStageRequirementsStatus, listLostReasons, type StageRequirementStatus, type LostReasonOption } from "./queries";

export type OpportunityActionState = {
  ok: boolean;
  error?: string;
  opportunityId?: string;
};

const PERMISSION_DENIED_MESSAGE = "Você não tem permissão para fazer isso.";

async function requirePermissionSafe(
  permission: Permission,
): Promise<{ ctx: Awaited<ReturnType<typeof requirePermission>> } | { deniedMessage: string }> {
  try {
    return { ctx: await requirePermission(permission) };
  } catch (error) {
    if (error instanceof AuthzError) return { deniedMessage: PERMISSION_DENIED_MESSAGE };
    throw error;
  }
}

export async function createOpportunityAction(
  _prevState: OpportunityActionState,
  formData: FormData,
): Promise<OpportunityActionState> {
  const guard = await requirePermissionSafe("opportunity.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = createOpportunitySchema.safeParse({
    leadId: formData.get("leadId"),
    pipelineId: formData.get("pipelineId") ?? "",
    stageId: formData.get("stageId") ?? "",
    valueCents: formData.get("valueCents") || undefined,
    feeModel: formData.get("feeModel") ?? "",
    probability: formData.get("probability") || undefined,
    forecastDate: formData.get("forecastDate") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_opportunity", {
    p_lead_id: parsed.data.leadId,
    ...(parsed.data.pipelineId ? { p_pipeline_id: parsed.data.pipelineId } : {}),
    ...(parsed.data.stageId ? { p_stage_id: parsed.data.stageId } : {}),
    ...(parsed.data.valueCents !== undefined ? { p_value_cents: parsed.data.valueCents } : {}),
    ...(parsed.data.feeModel ? { p_fee_model: parsed.data.feeModel } : {}),
    ...(parsed.data.probability !== undefined ? { p_probability: parsed.data.probability } : {}),
    ...(parsed.data.forecastDate ? { p_forecast_date: parsed.data.forecastDate } : {}),
  });

  if (error || !data) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/pipeline");
  revalidatePath(`/leads/${parsed.data.leadId}`);
  return { ok: true, opportunityId: data };
}

export async function moveOpportunityStageAction(
  _prevState: OpportunityActionState,
  formData: FormData,
): Promise<OpportunityActionState> {
  const guard = await requirePermissionSafe("opportunity.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const rawRequirementValues = formData.get("requirementValues");
  let requirementValues: unknown = [];
  if (typeof rawRequirementValues === "string" && rawRequirementValues.length > 0) {
    try {
      requirementValues = JSON.parse(rawRequirementValues);
    } catch {
      return { ok: false, error: "Dados inválidos." };
    }
  }

  const parsed = moveOpportunityStageSchema.safeParse({
    opportunityId: formData.get("opportunityId"),
    fromStageId: formData.get("fromStageId"),
    toStageId: formData.get("toStageId"),
    lockVersion: formData.get("lockVersion"),
    requirementValues,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("move_opportunity_stage", {
    p_opportunity_id: parsed.data.opportunityId,
    p_from_stage_id: parsed.data.fromStageId,
    p_to_stage_id: parsed.data.toStageId,
    p_lock_version: parsed.data.lockVersion,
    p_requirement_values: parsed.data.requirementValues,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/pipeline");
  revalidatePath(`/oportunidades/${parsed.data.opportunityId}`);
  return { ok: true, opportunityId: parsed.data.opportunityId };
}

export async function winOpportunityAction(
  _prevState: OpportunityActionState,
  formData: FormData,
): Promise<OpportunityActionState> {
  const guard = await requirePermissionSafe("opportunity.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = winOpportunitySchema.safeParse({
    opportunityId: formData.get("opportunityId"),
    lockVersion: formData.get("lockVersion"),
    valueCents: formData.get("valueCents"),
    feeModel: formData.get("feeModel"),
    signedAt: formData.get("signedAt") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("win_opportunity", {
    p_opportunity_id: parsed.data.opportunityId,
    p_lock_version: parsed.data.lockVersion,
    p_value_cents: parsed.data.valueCents,
    p_fee_model: parsed.data.feeModel,
    ...(parsed.data.signedAt ? { p_signed_at: parsed.data.signedAt } : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/pipeline");
  revalidatePath(`/oportunidades/${parsed.data.opportunityId}`);
  return { ok: true, opportunityId: parsed.data.opportunityId };
}

export async function loseOpportunityAction(
  _prevState: OpportunityActionState,
  formData: FormData,
): Promise<OpportunityActionState> {
  const guard = await requirePermissionSafe("opportunity.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = loseOpportunitySchema.safeParse({
    opportunityId: formData.get("opportunityId"),
    lockVersion: formData.get("lockVersion"),
    lostReasonId: formData.get("lostReasonId"),
    lostNote: formData.get("lostNote") ?? "",
    followupDate: formData.get("followupDate") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("lose_opportunity", {
    p_opportunity_id: parsed.data.opportunityId,
    p_lock_version: parsed.data.lockVersion,
    p_lost_reason_id: parsed.data.lostReasonId,
    ...(parsed.data.lostNote ? { p_lost_note: parsed.data.lostNote } : {}),
    ...(parsed.data.followupDate ? { p_followup_date: parsed.data.followupDate } : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/pipeline");
  revalidatePath(`/oportunidades/${parsed.data.opportunityId}`);
  return { ok: true, opportunityId: parsed.data.opportunityId };
}

/**
 * Chamada pelo kanban (Client Component) ANTES de tentar mover, para
 * decidir se abre o StageAdvanceDialog. A checagem de verdade — que
 * bloqueia de fato — é a mesma regra dentro de move_opportunity_stage()
 * no banco; esta Server Action só evita abrir um modal desnecessário
 * quando não há nada pendente no caminho.
 */
export async function checkStageRequirementsAction(
  opportunityId: string,
  toStageId: string,
): Promise<StageRequirementStatus[]> {
  const guard = await requirePermissionSafe("opportunity.view");
  if ("deniedMessage" in guard) return [];
  return getStageRequirementsStatus(opportunityId, toStageId);
}

export async function listLostReasonsAction(workspaceId: string): Promise<LostReasonOption[]> {
  const guard = await requirePermissionSafe("opportunity.view");
  if ("deniedMessage" in guard) return [];
  return listLostReasons(workspaceId);
}

export type PipelineConfigActionState = { ok: boolean; error?: string };

export async function createPipelineStageAction(
  _prevState: PipelineConfigActionState,
  formData: FormData,
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = createPipelineStageSchema.safeParse({
    pipelineId: formData.get("pipelineId"),
    name: formData.get("name"),
    color: formData.get("color") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("create_pipeline_stage", {
    p_pipeline_id: parsed.data.pipelineId,
    p_name: parsed.data.name,
    ...(parsed.data.color ? { p_color: parsed.data.color } : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/pipeline");
  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}

export async function deletePipelineStageAction(
  _prevState: PipelineConfigActionState,
  formData: FormData,
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const stageId = formData.get("stageId");
  if (typeof stageId !== "string" || stageId.length === 0) {
    return { ok: false, error: "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("delete_pipeline_stage", { p_stage_id: stageId });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/pipeline");
  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}

export async function createStageRequirementAction(
  _prevState: PipelineConfigActionState,
  formData: FormData,
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = createStageRequirementSchema.safeParse({
    stageId: formData.get("stageId"),
    label: formData.get("label"),
    fieldType: formData.get("fieldType"),
    hint: formData.get("hint") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("create_stage_requirement", {
    p_stage_id: parsed.data.stageId,
    p_label: parsed.data.label,
    p_field_type: parsed.data.fieldType,
    ...(parsed.data.hint ? { p_hint: parsed.data.hint } : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}

export async function createLostReasonAction(
  _prevState: PipelineConfigActionState,
  formData: FormData,
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = createLostReasonSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
    label: formData.get("label"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("create_lost_reason", {
    p_workspace_id: parsed.data.workspaceId,
    p_label: parsed.data.label,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}
