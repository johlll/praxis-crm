"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { toUserMessage } from "@/lib/errors";
import type { Permission } from "@/lib/roles";
import {
  archiveCustomFieldSchema,
  createCustomFieldSchema,
  parseOptionLines,
  saveCustomFieldValuesSchema,
  updateCustomFieldSchema,
  type CustomFieldEntity,
} from "./schema";

export type CustomFieldActionState = { ok: boolean; error?: string };
const SETTINGS_PATH = "/configuracoes/campos-personalizados";

const EDIT_PERMISSION: Record<CustomFieldEntity, Permission> = {
  contact: "contact.edit",
  lead: "lead.edit",
  opportunity: "opportunity.edit",
  client: "client.manage",
};

const RECORD_PATH: Record<CustomFieldEntity, string> = {
  contact: "/contatos/",
  lead: "/leads/",
  opportunity: "/oportunidades/",
  client: "/clientes/",
};

export async function createCustomFieldAction(
  _previous: CustomFieldActionState,
  formData: FormData,
): Promise<CustomFieldActionState> {
  const guard = await requirePermissionSafe("custom_field.manage");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = createCustomFieldSchema.safeParse({
    entityType: formData.get("entityType"),
    name: formData.get("name"),
    fieldType: formData.get("fieldType"),
    position: formData.get("position"),
    options: formData.get("options") ?? "",
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

  const options = parseOptionLines(parsed.data.options);
  if (parsed.data.fieldType === "single_select" && options.length === 0) {
    return { ok: false, error: "Informe ao menos uma opção." };
  }
  if (new Set(options.map((item) => item.toLocaleLowerCase("pt-BR"))).size !== options.length) {
    return { ok: false, error: "Não repita opções no mesmo campo." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("create_custom_field_definition", {
    p_workspace_id: guard.ctx.workspaceId,
    p_entity_type: parsed.data.entityType,
    p_name: parsed.data.name,
    p_field_type: parsed.data.fieldType,
    p_position: parsed.data.position,
    p_options: options,
  });
  if (error) return { ok: false, error: toUserMessage(error) };
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}
export async function updateCustomFieldAction(
  _previous: CustomFieldActionState,
  formData: FormData,
): Promise<CustomFieldActionState> {
  const guard = await requirePermissionSafe("custom_field.manage");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = updateCustomFieldSchema.safeParse({
    definitionId: formData.get("definitionId"),
    name: formData.get("name"),
    position: formData.get("position"),
    optionsJson: formData.get("optionsJson"),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

  let options: unknown;
  try { options = JSON.parse(parsed.data.optionsJson); } catch { return { ok: false, error: "Opções inválidas." }; }
  if (!Array.isArray(options)) return { ok: false, error: "Opções inválidas." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_custom_field_definition", {
    p_definition_id: parsed.data.definitionId,
    p_name: parsed.data.name,
    p_position: parsed.data.position,
    p_options: options,
  });
  if (error) return { ok: false, error: toUserMessage(error) };
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}
export async function archiveCustomFieldAction(
  _previous: CustomFieldActionState,
  formData: FormData,
): Promise<CustomFieldActionState> {
  const guard = await requirePermissionSafe("custom_field.manage");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = archiveCustomFieldSchema.safeParse({ definitionId: formData.get("definitionId") });
  if (!parsed.success) return { ok: false, error: "Campo inválido." };
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("archive_custom_field_definition", {
    p_definition_id: parsed.data.definitionId,
  });
  if (error) return { ok: false, error: toUserMessage(error) };
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

export async function saveCustomFieldValuesAction(
  _previous: CustomFieldActionState,
  formData: FormData,
): Promise<CustomFieldActionState> {
  const parsed = saveCustomFieldValuesSchema.safeParse({
    entityType: formData.get("entityType"),
    recordId: formData.get("recordId"),
    valuesJson: formData.get("valuesJson"),
  });
  if (!parsed.success) return { ok: false, error: "Valores inválidos." };
  const guard = await requirePermissionSafe(EDIT_PERMISSION[parsed.data.entityType]);
  if ("error" in guard) return { ok: false, error: guard.error };

  let values: unknown;
  try { values = JSON.parse(parsed.data.valuesJson); } catch { return { ok: false, error: "Valores inválidos." }; }
  if (!Array.isArray(values) || values.length > 50) return { ok: false, error: "Valores inválidos." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_custom_field_values", {
    p_workspace_id: guard.ctx.workspaceId,
    p_record_id: parsed.data.recordId,
    p_values: values,
  });
  if (error) return { ok: false, error: toUserMessage(error) };
  revalidatePath(`${RECORD_PATH[parsed.data.entityType]}${parsed.data.recordId}`);
  return { ok: true };
}
