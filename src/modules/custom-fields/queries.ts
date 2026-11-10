import { z } from "zod";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError, isExpectedAbsence } from "@/server/data/load-error";
import {
  customFieldDefinitionRowSchema,
  customFieldValueRowSchema,
  type CustomFieldEntity,
  type CustomFieldType,
} from "./schema";

/**
 * Leitura dos campos personalizados (C4). Passa SÓ pelas RPCs
 * `list_custom_field_definitions` (owner e admin) e `get_custom_field_values`
 * (permissão e alcance da entidade): as tabelas não têm grant para o cliente.
 *
 * Contrato de erro (docs/decisoes/estabilizacao-pos-a9.md §1):
 *  - `insufficient_permission` e registro/definição inexistente (inclusive de
 *    outro workspace) → `null`: a tela trata como "não encontrado";
 *  - qualquer outra falha, ou linha fora do formato → CustomFieldLoadError.
 *    Nunca vira lista vazia.
 */

export class CustomFieldLoadError extends DataLoadError {}

export type CustomFieldOption = { id: string; label: string };

export type CustomFieldDefinition = {
  id: string;
  entity: CustomFieldEntity;
  name: string;
  type: CustomFieldType;
  position: number;
  archived: boolean;
  options: Array<CustomFieldOption & { inUse: boolean }>;
};

export type CustomFieldValueField = {
  definitionId: string;
  name: string;
  type: CustomFieldType;
  position: number;
  options: CustomFieldOption[];
  /** texto, número, data (AAAA-MM-DD), booleano ou id da opção; null = sem valor. */
  value: string | number | boolean | null;
};

const ABSENT = ["insufficient_permission", "custom_field_record_not_found", "custom_field_not_found"];

/** Administração: todas as definições do workspace (inclusive arquivadas). */
export async function listCustomFieldDefinitions(workspaceId: string): Promise<CustomFieldDefinition[] | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_custom_field_definitions", { p_workspace_id: workspaceId });

  if (error) {
    if (isExpectedAbsence(error, ABSENT)) return null;
    throw new CustomFieldLoadError(`os campos personalizados do workspace ${workspaceId}`, error);
  }

  const rows = z.array(customFieldDefinitionRowSchema).safeParse(data);
  if (!rows.success) {
    throw new CustomFieldLoadError(`os campos personalizados do workspace ${workspaceId} (formato inesperado)`, rows.error);
  }

  return rows.data.map(
    (row): CustomFieldDefinition => ({
      id: row.id,
      entity: row.entity_type,
      name: row.name,
      type: row.field_type,
      position: row.position,
      archived: row.archived,
      options: row.options.map((option) => ({ id: option.id, label: option.label, inUse: option.in_use })),
    }),
  );
}

/** Campos ATIVOS da entidade, com o valor atual do registro (alcance conferido no banco). */
export async function getCustomFieldValues(
  entity: CustomFieldEntity,
  recordId: string,
): Promise<CustomFieldValueField[] | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_custom_field_values", {
    p_entity_type: entity,
    p_record_id: recordId,
  });

  if (error) {
    if (isExpectedAbsence(error, ABSENT)) return null;
    throw new CustomFieldLoadError(`os campos personalizados do registro ${recordId}`, error);
  }

  const rows = z.array(customFieldValueRowSchema).safeParse(data);
  if (!rows.success) {
    throw new CustomFieldLoadError(`os campos personalizados do registro ${recordId} (formato inesperado)`, rows.error);
  }

  return rows.data.map(
    (row): CustomFieldValueField => ({
      definitionId: row.definition_id,
      name: row.name,
      type: row.field_type,
      position: row.position,
      options: row.options,
      value: row.value,
    }),
  );
}
