"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermission, AuthzError, type Permission } from "@/server/authz/permissions";
import { toUserMessage } from "@/lib/errors";
import { assignLeadSchema, createLeadSchema, setLeadStatusSchema, updateLeadBasicFieldsSchema } from "./schema";

export type LeadActionState = {
  ok: boolean;
  error?: string;
  leadId?: string;
};

const PERMISSION_DENIED_MESSAGE = "Você não tem permissão para fazer isso.";

/**
 * Mesmo problema já corrigido na A3 (requirePermission() lança dentro de
 * Server Action = página inteira quebra) — aqui TODA ação retorna
 * {ok, error}, mesmo as mais simples (arquivar, atribuir responsável):
 * por instrução explícita desta fase, nenhuma ação void que engula a
 * exceção sem dar retorno visível a quem clicou.
 */
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

export async function createLeadAction(
  _prevState: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const guard = await requirePermissionSafe("lead.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };
  const ctx = guard.ctx;

  const parsed = createLeadSchema.safeParse({
    workspaceId: ctx.workspaceId,
    contactId: formData.get("contactId"),
    legalArea: formData.get("legalArea"),
    summary: formData.get("summary") ?? "",
    tags: formData.get("tags") ?? "",
    priority: formData.get("priority") || undefined,
    assignedTo: formData.get("assignedTo") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_lead", {
    p_workspace_id: parsed.data.workspaceId,
    p_contact_id: parsed.data.contactId,
    p_legal_area: parsed.data.legalArea,
    ...(parsed.data.summary ? { p_summary: parsed.data.summary } : {}),
    p_tags: parsed.data.tags,
    p_priority: parsed.data.priority,
    ...(parsed.data.assignedTo ? { p_assigned_to: parsed.data.assignedTo } : {}),
  });

  if (error || !data) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/leads");
  redirect(`/leads/${data}`);
}

export async function updateLeadBasicFieldsAction(
  _prevState: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const guard = await requirePermissionSafe("lead.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = updateLeadBasicFieldsSchema.safeParse({
    leadId: formData.get("leadId"),
    legalArea: formData.get("legalArea"),
    summary: formData.get("summary") ?? "",
    tags: formData.get("tags") ?? "",
    priority: formData.get("priority") || undefined,
    expectedUpdatedAt: formData.get("expectedUpdatedAt") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_lead_basic_fields", {
    p_lead_id: parsed.data.leadId,
    p_legal_area: parsed.data.legalArea,
    ...(parsed.data.summary ? { p_summary: parsed.data.summary } : {}),
    p_tags: parsed.data.tags,
    p_priority: parsed.data.priority,
    p_expected_updated_at: parsed.data.expectedUpdatedAt,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath(`/leads/${parsed.data.leadId}`);
  return { ok: true, leadId: parsed.data.leadId };
}

export async function assignLeadAction(
  _prevState: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const guard = await requirePermissionSafe("lead.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = assignLeadSchema.safeParse({
    leadId: formData.get("leadId"),
    assignedTo: formData.get("assignedTo") ?? "",
    expectedUpdatedAt: formData.get("expectedUpdatedAt") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("assign_lead", {
    p_lead_id: parsed.data.leadId,
    ...(parsed.data.assignedTo ? { p_assigned_to: parsed.data.assignedTo } : {}),
    p_expected_updated_at: parsed.data.expectedUpdatedAt,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath(`/leads/${parsed.data.leadId}`);
  revalidatePath("/leads");
  return { ok: true, leadId: parsed.data.leadId };
}

export async function setLeadStatusAction(
  _prevState: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const guard = await requirePermissionSafe("lead.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = setLeadStatusSchema.safeParse({
    leadId: formData.get("leadId"),
    status: formData.get("status"),
    expectedUpdatedAt: formData.get("expectedUpdatedAt") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_lead_status", {
    p_lead_id: parsed.data.leadId,
    p_status: parsed.data.status,
    p_expected_updated_at: parsed.data.expectedUpdatedAt,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath(`/leads/${parsed.data.leadId}`);
  revalidatePath("/leads");
  return { ok: true, leadId: parsed.data.leadId };
}
