"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { requireWorkspace } from "@/server/authz/permissions";
import { toUserMessage } from "@/lib/errors";
import { generateEndpointPublicKey } from "@/server/ingest/submission";
import { uuidSchema } from "@/lib/uuid";
import { correctLinkSchema, formEndpointIdSchema, formEndpointSchema, setStatusSchema } from "./schema";

export type FormActionState = { ok: boolean; error?: string; publicKey?: string };

export type ContinuityActionState = { ok: boolean; error?: string; token?: string; expiresAt?: string };

const issueContinuitySchema = z.object({
  leadId: uuidSchema,
  opportunityId: uuidSchema.or(z.literal("")).optional(),
  validityHours: z.coerce.number().int().min(1).max(2160).default(720),
});

const revokeContinuitySchema = z.object({ continuityReferenceId: uuidSchema });

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
    answersConfigJson: formData.get("answersConfigJson") ?? undefined,
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
    p_answers_config: parsed.data.answersConfigJson,
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
    answersConfigJson: formData.get("answersConfigJson") ?? undefined,
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
    p_answers_config: parsed.data.answersConfigJson,
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

/**
 * Emite um token de continuidade (A11, item 5 da auditoria pós-dry-run):
 * aleatório, gerado NO SERVIDOR pela RPC, devolvido uma única vez. O
 * componente que chama esta action é responsável por mostrar o token ao
 * usuário AGORA — ele nunca é recuperável depois (o banco só guarda o
 * hash).
 */
export async function issueContinuityReferenceAction(
  _prev: ContinuityActionState,
  formData: FormData,
): Promise<ContinuityActionState> {
  const guard = await requirePermissionSafe("continuity.issue");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = issueContinuitySchema.safeParse({
    leadId: formData.get("leadId"),
    opportunityId: formData.get("opportunityId") ?? "",
    validityHours: formData.get("validityHours") ?? undefined,
  });
  if (!parsed.success) return { ok: false, error: "Dados inválidos para gerar o link." };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("issue_continuity_reference", {
    p_lead_id: parsed.data.leadId,
    ...(parsed.data.opportunityId ? { p_opportunity_id: parsed.data.opportunityId } : {}),
    p_validity_hours: parsed.data.validityHours,
  });

  if (error) return { ok: false, error: toUserMessage(error) };

  const result = data as unknown as { token: string; expires_at: string };
  return { ok: true, token: result.token, expiresAt: result.expires_at };
}

export async function revokeContinuityReferenceAction(
  _prev: ContinuityActionState,
  formData: FormData,
): Promise<ContinuityActionState> {
  const guard = await requirePermissionSafe("continuity.issue");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = revokeContinuitySchema.safeParse({
    continuityReferenceId: formData.get("continuityReferenceId"),
  });
  if (!parsed.success) return { ok: false, error: "Referência inválida." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("revoke_continuity_reference", {
    p_continuity_reference_id: parsed.data.continuityReferenceId,
  });

  if (error) return { ok: false, error: toUserMessage(error) };
  return { ok: true };
}
