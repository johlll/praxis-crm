"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { DataLoadError, LOAD_ERROR_MESSAGE } from "@/server/data/load-error";
import { toUserMessage } from "@/lib/errors";
import {
  createOpportunitySchema,
  moveOpportunityStageSchema,
  winOpportunitySchema,
  loseOpportunitySchema,
  createPipelineStageSchema,
  updatePipelineStageSchema,
  reorderPipelineStagesSchema,
  createStageRequirementSchema,
  updateStageRequirementSchema,
  deleteStageRequirementSchema,
  createLostReasonSchema,
  deactivateLostReasonSchema,
} from "./schema";
import {
  getStageRequirementsStatus,
  getWinRequirementsStatus,
  listLostReasons,
  type StageRequirementStatus,
  type LostReasonOption,
} from "./queries";

export type OpportunityActionState = {
  ok: boolean;
  error?: string;
  opportunityId?: string;
};

export async function createOpportunityAction(
  _prevState: OpportunityActionState,
  formData: FormData,
): Promise<OpportunityActionState> {
  const guard = await requirePermissionSafe("opportunity.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

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
  revalidatePath("/visao-geral");
  revalidatePath(`/leads/${parsed.data.leadId}`);
  return { ok: true, opportunityId: data };
}

export async function moveOpportunityStageAction(
  _prevState: OpportunityActionState,
  formData: FormData,
): Promise<OpportunityActionState> {
  const guard = await requirePermissionSafe("opportunity.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

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
  revalidatePath("/visao-geral");
  revalidatePath(`/oportunidades/${parsed.data.opportunityId}`);
  // O kanban não passa `leadId` (não precisa — não existe página de lead
  // aberta ao mesmo tempo); o controle de etapa do Perfil 360 passa, para
  // a StageProgressBar/OpportunityDetailPanel refletirem o movimento sem
  // precisar trocar de aba (achado do review pós-CI: mover etapa ali
  // ficava sem revalidação própria).
  const leadId = formData.get("leadId");
  if (typeof leadId === "string" && leadId) revalidatePath(`/leads/${leadId}`);
  return { ok: true, opportunityId: parsed.data.opportunityId };
}

export async function winOpportunityAction(
  _prevState: OpportunityActionState,
  formData: FormData,
): Promise<OpportunityActionState> {
  const guard = await requirePermissionSafe("opportunity.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

  const rawRequirementValues = formData.get("requirementValues");
  let requirementValues: unknown = [];
  if (typeof rawRequirementValues === "string" && rawRequirementValues.length > 0) {
    try {
      requirementValues = JSON.parse(rawRequirementValues);
    } catch {
      return { ok: false, error: "Dados inválidos." };
    }
  }

  const parsed = winOpportunitySchema.safeParse({
    opportunityId: formData.get("opportunityId"),
    lockVersion: formData.get("lockVersion"),
    valueCents: formData.get("valueCents"),
    feeModel: formData.get("feeModel"),
    signedAt: formData.get("signedAt") ?? "",
    requirementValues,
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
    p_requirement_values: parsed.data.requirementValues,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/pipeline");
  revalidatePath("/visao-geral");
  revalidatePath(`/oportunidades/${parsed.data.opportunityId}`);
  return { ok: true, opportunityId: parsed.data.opportunityId };
}

export async function loseOpportunityAction(
  _prevState: OpportunityActionState,
  formData: FormData,
): Promise<OpportunityActionState> {
  const guard = await requirePermissionSafe("opportunity.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

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
  revalidatePath("/visao-geral");
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
export type RequirementsResult =
  | { ok: true; requirements: StageRequirementStatus[] }
  | { ok: false; error: string };

const OPPORTUNITY_UNAVAILABLE_MESSAGE = "Esta oportunidade não está mais disponível. Recarregue a página.";

/**
 * Lista vazia aqui significa "nenhum requisito pendente" e libera o avanço
 * sem diálogo — por isso negação, oportunidade inacessível e falha
 * operacional chegam ao cliente como `ok: false`, nunca como `[]`.
 */
async function loadRequirements(
  load: () => Promise<StageRequirementStatus[] | null>,
): Promise<RequirementsResult> {
  const guard = await requirePermissionSafe("opportunity.view");
  if ("error" in guard) return { ok: false, error: guard.error };
  try {
    const requirements = await load();
    if (requirements === null) return { ok: false, error: OPPORTUNITY_UNAVAILABLE_MESSAGE };
    return { ok: true, requirements };
  } catch (error) {
    if (error instanceof DataLoadError) return { ok: false, error: LOAD_ERROR_MESSAGE };
    throw error;
  }
}

export async function checkStageRequirementsAction(opportunityId: string, toStageId: string): Promise<RequirementsResult> {
  return loadRequirements(() => getStageRequirementsStatus(opportunityId, toStageId));
}

/**
 * Chamada pelo WonDialog ao abrir — mostra o que falta preencher dos
 * requisitos marcados "obrigatório para marcar como ganho", em
 * qualquer etapa do pipeline (não só o caminho percorrido). A
 * checagem que bloqueia de fato é a mesma regra dentro de
 * win_opportunity() no banco.
 */
export async function checkWinRequirementsAction(opportunityId: string): Promise<RequirementsResult> {
  return loadRequirements(() => getWinRequirementsStatus(opportunityId));
}

export async function listLostReasonsAction(
  workspaceId: string,
): Promise<{ ok: true; reasons: LostReasonOption[] } | { ok: false; error: string }> {
  const guard = await requirePermissionSafe("opportunity.view");
  if ("error" in guard) return { ok: false, error: guard.error };
  try {
    return { ok: true, reasons: await listLostReasons(workspaceId) };
  } catch (error) {
    if (error instanceof DataLoadError) return { ok: false, error: LOAD_ERROR_MESSAGE };
    throw error;
  }
}

export type PipelineConfigActionState = { ok: boolean; error?: string };

export async function createPipelineStageAction(
  _prevState: PipelineConfigActionState,
  formData: FormData,
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("error" in guard) return { ok: false, error: guard.error };

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
  revalidatePath("/visao-geral");
  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}

export async function deletePipelineStageAction(
  _prevState: PipelineConfigActionState,
  formData: FormData,
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("error" in guard) return { ok: false, error: guard.error };

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
  revalidatePath("/visao-geral");
  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}

export async function updatePipelineStageAction(
  _prevState: PipelineConfigActionState,
  formData: FormData,
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("error" in guard) return { ok: false, error: guard.error };

  // Checkbox desmarcado simplesmente não aparece no FormData — por isso a
  // presença da chave (has), não o valor (get), é o que decide true/false
  // aqui. O formulário sempre renderiza os dois checkboxes (nunca um
  // update parcial só de um dos dois), então sempre enviamos ambos
  // explicitamente — nunca `undefined`, que faria a RPC MANTER o valor
  // atual (coalesce) em vez de desmarcar.
  const parsed = updatePipelineStageSchema.safeParse({
    stageId: formData.get("stageId"),
    name: formData.get("name") ?? "",
    color: formData.get("color") ?? "",
    isWon: formData.has("isWon"),
    isLost: formData.has("isLost"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_pipeline_stage", {
    p_stage_id: parsed.data.stageId,
    ...(parsed.data.name ? { p_name: parsed.data.name } : {}),
    ...(parsed.data.color ? { p_color: parsed.data.color } : {}),
    ...(parsed.data.isWon !== undefined ? { p_is_won: parsed.data.isWon } : {}),
    ...(parsed.data.isLost !== undefined ? { p_is_lost: parsed.data.isLost } : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/pipeline");
  revalidatePath("/visao-geral");
  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}

export async function reorderPipelineStagesAction(
  pipelineId: string,
  orderedStageIds: string[],
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = reorderPipelineStagesSchema.safeParse({ pipelineId, orderedStageIds });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("reorder_pipeline_stages", {
    p_pipeline_id: parsed.data.pipelineId,
    p_ordered_stage_ids: parsed.data.orderedStageIds,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/pipeline");
  revalidatePath("/visao-geral");
  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}

export async function createStageRequirementAction(
  _prevState: PipelineConfigActionState,
  formData: FormData,
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = createStageRequirementSchema.safeParse({
    stageId: formData.get("stageId"),
    label: formData.get("label"),
    fieldType: formData.get("fieldType"),
    hint: formData.get("hint") ?? "",
    requiredForWin: formData.has("requiredForWin"),
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
    p_required_for_win: parsed.data.requiredForWin,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}

export async function updateStageRequirementAction(
  requirementId: string,
  requiredForWin: boolean,
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = updateStageRequirementSchema.safeParse({ requirementId, requiredForWin });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_stage_requirement", {
    p_requirement_id: parsed.data.requirementId,
    p_required_for_win: parsed.data.requiredForWin,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}

export async function deleteStageRequirementAction(
  _prevState: PipelineConfigActionState,
  formData: FormData,
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = deleteStageRequirementSchema.safeParse({
    requirementId: formData.get("requirementId"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("delete_stage_requirement", {
    p_requirement_id: parsed.data.requirementId,
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
  if ("error" in guard) return { ok: false, error: guard.error };

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

export async function deactivateLostReasonAction(
  _prevState: PipelineConfigActionState,
  formData: FormData,
): Promise<PipelineConfigActionState> {
  const guard = await requirePermissionSafe("pipeline.configure");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = deactivateLostReasonSchema.safeParse({
    lostReasonId: formData.get("lostReasonId"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("deactivate_lost_reason", {
    p_lost_reason_id: parsed.data.lostReasonId,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}
