"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { toUserMessage } from "@/lib/errors";
import { uuidSchema } from "@/lib/uuid";
import type { Permission } from "@/lib/roles";
import { getCustomFieldValues } from "./queries";
import {
  coerceCustomFieldValue,
  CUSTOM_FIELD_INPUT_PREFIX,
  CUSTOM_FIELD_PATH,
  CUSTOM_FIELD_RECORD_PATH,
  customFieldDefinitionFormSchema,
  customFieldEntitySchema,
  optionsRpcArg,
  parseOptionsField,
} from "./schema";

/**
 * Server Actions dos campos personalizados (C4).
 *
 * Definições: exigem `custom_field.manage` (owner e admin); o workspace vem
 * SEMPRE da sessão, nunca do formulário. Valores: exigem a permissão de edição
 * da ENTIDADE (contact.edit, lead.edit, opportunity.edit; client.manage) — não
 * existe permissão própria que contorne as projeções existentes. Em ambos, o
 * banco repete a autorização e o alcance por registro. Erros voltam
 * sanitizados (toUserMessage): nada do texto do banco chega à tela.
 */

const GENERIC_ERROR = "Não foi possível concluir a operação. Tente novamente.";

export type SaveCustomFieldDefinitionResult = { ok: true; definitionId: string } | { ok: false; error: string };

export async function saveCustomFieldDefinitionAction(formData: FormData): Promise<SaveCustomFieldDefinitionResult> {
  const guard = await requirePermissionSafe("custom_field.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const options = parseOptionsField(formData.get("options"));
  if (options === null) return { ok: false, error: "Opções inválidas." };

  const parsed = customFieldDefinitionFormSchema.safeParse({
    definitionId: formData.get("definitionId") ?? "",
    entity: formData.get("entity") ?? "",
    name: formData.get("name") ?? "",
    type: formData.get("type") ?? "",
    position: formData.get("position") ?? "",
    options,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const form = parsed.data;
  const supabase = await createServerSupabaseClient();

  if (form.definitionId) {
    // Edição: o banco não recebe tipo nem entidade (não mudam depois de criados).
    const { error } = await supabase.rpc("update_custom_field", {
      p_definition_id: form.definitionId,
      p_name: form.name,
      ...(form.position !== null ? { p_position: form.position } : {}),
      ...(form.type === "select" ? { p_options: optionsRpcArg(form.options) } : {}),
    });
    if (error) return { ok: false, error: toUserMessage(error) };
    revalidatePath(CUSTOM_FIELD_PATH);
    return { ok: true, definitionId: form.definitionId };
  }

  const { data, error } = await supabase.rpc("create_custom_field", {
    p_workspace_id: guard.ctx.workspaceId,
    p_entity_type: form.entity,
    p_name: form.name,
    p_field_type: form.type,
    ...(form.position !== null ? { p_position: form.position } : {}),
    ...(form.type === "select" ? { p_options: optionsRpcArg(form.options) } : {}),
  });
  if (error || !data) return { ok: false, error: toUserMessage(error) };
  revalidatePath(CUSTOM_FIELD_PATH);
  return { ok: true, definitionId: data };
}

/** Arquivar preserva todos os valores; restaurar devolve o campo aos formulários. */
export async function setCustomFieldArchivedAction(
  definitionId: string,
  archived: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const guard = await requirePermissionSafe("custom_field.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const id = uuidSchema.safeParse(definitionId);
  if (!id.success || typeof archived !== "boolean") return { ok: false, error: "Dados inválidos." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_custom_field_archived", { p_definition_id: id.data, p_archived: archived });
  if (error) return { ok: false, error: toUserMessage(error) };

  revalidatePath(CUSTOM_FIELD_PATH);
  return { ok: true };
}

const EDIT_PERMISSION: Record<"contact" | "lead" | "opportunity" | "client", Permission> = {
  contact: "contact.edit",
  lead: "lead.edit",
  opportunity: "opportunity.edit",
  client: "client.manage",
};

export type SaveCustomFieldValuesResult = { ok: true; changed: number } | { ok: false; error: string };

/**
 * Grava os valores dos campos ATIVOS de um registro numa só chamada (tudo ou
 * nada). A entidade vem da chamada (lista fechada) e o registro, do servidor
 * que renderizou a tela; o workspace nunca é enviado — o banco o deduz do
 * registro. Os tipos vêm do BANCO (get_custom_field_values), não do navegador.
 */
export async function saveCustomFieldValuesAction(
  entity: string,
  recordId: string,
  formData: FormData,
): Promise<SaveCustomFieldValuesResult> {
  const parsedEntity = customFieldEntitySchema.safeParse(entity);
  const parsedId = uuidSchema.safeParse(recordId);
  if (!parsedEntity.success || !parsedId.success) return { ok: false, error: "Registro não encontrado." };

  const guard = await requirePermissionSafe(EDIT_PERMISSION[parsedEntity.data]);
  if ("error" in guard) return { ok: false, error: guard.error };

  let fields;
  try {
    fields = await getCustomFieldValues(parsedEntity.data, parsedId.data);
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
  if (fields === null) return { ok: false, error: "Registro não encontrado." };

  const values: Array<{ definition_id: string; value: string | number | boolean | null }> = [];
  for (const field of fields) {
    const raw = formData.get(`${CUSTOM_FIELD_INPUT_PREFIX}${field.definitionId}`);
    // Campo ausente do envio = não mexer; só o que veio é gravado.
    if (raw === null) continue;
    if (typeof raw !== "string") return { ok: false, error: "Dados inválidos." };
    const coerced = coerceCustomFieldValue(field.type, raw);
    if (!coerced.ok) return { ok: false, error: `${field.name}: ${coerced.error}` };
    values.push({ definition_id: field.definitionId, value: coerced.value });
  }
  if (values.length === 0) return { ok: true, changed: 0 };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("set_custom_field_values", {
    p_entity_type: parsedEntity.data,
    p_record_id: parsedId.data,
    p_values: values,
  });
  if (error) return { ok: false, error: toUserMessage(error) };

  revalidatePath(CUSTOM_FIELD_RECORD_PATH[parsedEntity.data](parsedId.data));
  return { ok: true, changed: typeof data === "number" ? data : 0 };
}
