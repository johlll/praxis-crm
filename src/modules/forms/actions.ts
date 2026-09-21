"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { requireWorkspace } from "@/server/authz/permissions";
import { toUserMessage } from "@/lib/errors";
import { generateEndpointPublicKey } from "@/server/ingest/submission";
import { correctLinkSchema, formEndpointIdSchema, formEndpointSchema, setStatusSchema } from "./schema";

export type FormActionState = { ok: boolean; error?: string; publicKey?: string };

function revalidateForms() {
  revalidatePath("/configuracoes/formularios");
}

export async function createFormEndpointAction(
  _prev: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const guard = await requirePermissionSafe("form_endpoint.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = formEndpointSchema.safeParse({
    name: formData.get("name"),
    pipelineId: formData.get("pipelineId"),
    stageId: formData.get("stageId"),
    legalArea: formData.get("legalArea"),
    initialActivityType: formData.get("initialActivityType"),
    initialActivityDueMinutes: formData.get("initialActivityDueMinutes"),
    captureMode: formData.get("captureMode"),
    turnstileAction: formData.get("turnstileAction"),
    allowedHostnames: formData.get("allowedHostnames"),
  });
  if (!parsed.success) return { ok: false, error: "Confira os campos do formulário." };

  const workspaceId = await requireWorkspace();
  const supabase = await createServerSupabaseClient();
  // A chave opaca nasce no SERVIDOR — nunca vem do navegador.
  const publicKey = generateEndpointPublicKey();

  const { error } = await supabase.rpc("create_form_endpoint", {
    p_workspace_id: workspaceId,
    p_name: parsed.data.name,
    p_pipeline_id: parsed.data.pipelineId,
    p_stage_id: parsed.data.stageId,
    p_legal_area: parsed.data.legalArea,
    p_initial_activity_type: parsed.data.initialActivityType,
    p_initial_activity_due_minutes: parsed.data.initialActivityDueMinutes,
    p_capture_mode: parsed.data.captureMode,
    p_turnstile_action: parsed.data.turnstileAction,
    p_allowed_hostnames: parsed.data.allowedHostnames,
    p_public_key: publicKey,
  });

  if (error) return { ok: false, error: toUserMessage(error) };

  revalidateForms();
  return { ok: true, publicKey };
}

export async function updateFormEndpointAction(
  _prev: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const guard = await requirePermissionSafe("form_endpoint.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const id = formEndpointIdSchema.safeParse({ formEndpointId: formData.get("formEndpointId") });
  const parsed = formEndpointSchema.safeParse({
    name: formData.get("name"),
    pipelineId: formData.get("pipelineId"),
    stageId: formData.get("stageId"),
    legalArea: formData.get("legalArea"),
    initialActivityType: formData.get("initialActivityType"),
    initialActivityDueMinutes: formData.get("initialActivityDueMinutes"),
    captureMode: formData.get("captureMode"),
    turnstileAction: formData.get("turnstileAction"),
    allowedHostnames: formData.get("allowedHostnames"),
  });
  if (!id.success || !parsed.success) return { ok: false, error: "Confira os campos do formulário." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_form_endpoint", {
    p_form_endpoint_id: id.data.formEndpointId,
    p_name: parsed.data.name,
    p_pipeline_id: parsed.data.pipelineId,
    p_stage_id: parsed.data.stageId,
    p_legal_area: parsed.data.legalArea,
    p_initial_activity_type: parsed.data.initialActivityType,
    p_initial_activity_due_minutes: parsed.data.initialActivityDueMinutes,
    p_capture_mode: parsed.data.captureMode,
    p_turnstile_action: parsed.data.turnstileAction,
    p_allowed_hostnames: parsed.data.allowedHostnames,
  });

  if (error) return { ok: false, error: toUserMessage(error) };
  revalidateForms();
  return { ok: true };
}

/**
 * Desativar/reativar. Desativar derruba a captação NOVA e não apaga nem
 * altera nenhum evento já recebido (contrato §4).
 */
export async function setFormEndpointStatusAction(
  _prev: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const guard = await requirePermissionSafe("form_endpoint.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = setStatusSchema.safeParse({
    formEndpointId: formData.get("formEndpointId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return { ok: false, error: "Ação inválida." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_form_endpoint_status", {
    p_form_endpoint_id: parsed.data.formEndpointId,
    p_status: parsed.data.status,
  });

  if (error) return { ok: false, error: toUserMessage(error) };
  revalidateForms();
  return { ok: true };
}

/**
 * Rotação: chave nova, chave anterior REVOGADA (continua existindo, mas
 * passa a receber a recusa genérica).
 */
export async function rotateFormEndpointKeyAction(
  _prev: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const guard = await requirePermissionSafe("form_endpoint.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = formEndpointIdSchema.safeParse({ formEndpointId: formData.get("formEndpointId") });
  if (!parsed.success) return { ok: false, error: "Formulário inválido." };

  const supabase = await createServerSupabaseClient();
  const publicKey = generateEndpointPublicKey();
  const { error } = await supabase.rpc("rotate_form_endpoint_key", {
    p_form_endpoint_id: parsed.data.formEndpointId,
    p_new_public_key: publicKey,
  });

  if (error) return { ok: false, error: toUserMessage(error) };
  revalidateForms();
  return { ok: true, publicKey };
}

/**
 * Correção do vínculo de atribuição. Concorrência otimista: quem corrige
 * declara a ponta vigente que está vendo; se outra pessoa corrigiu antes,
 * o servidor devolve conflito em vez de criar uma segunda ponta.
 */
export async function correctTouchpointLinkAction(
  _prev: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const guard = await requirePermissionSafe("attribution.correct");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = correctLinkSchema.safeParse({
    touchpointId: formData.get("touchpointId"),
    expectedCurrentLinkId: formData.get("expectedCurrentLinkId") ?? "",
    action: formData.get("action"),
    opportunityId: formData.get("opportunityId") ?? "",
    reason: formData.get("reason") ?? undefined,
    leadId: formData.get("leadId"),
  });
  if (!parsed.success) return { ok: false, error: "Correção inválida." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("correct_touchpoint_demand_link", {
    p_touchpoint_id: parsed.data.touchpointId,
    // Sem cadeia ainda: quem corrige declara "nenhuma ponta vigente" e a
    // RPC recusa se a ponta vigente for outra (conflito de versão).
    p_expected_current_link_id: (parsed.data.expectedCurrentLinkId || null) as unknown as string,
    p_action: parsed.data.action,
    ...(parsed.data.opportunityId ? { p_opportunity_id: parsed.data.opportunityId } : {}),
    ...(parsed.data.reason ? { p_reason: parsed.data.reason } : {}),
  });

  if (error) return { ok: false, error: toUserMessage(error) };

  revalidatePath(`/leads/${parsed.data.leadId}`);
  revalidatePath("/visao-geral");
  return { ok: true };
}
