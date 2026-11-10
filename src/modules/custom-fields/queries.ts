import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError } from "@/server/data/load-error";
import type { CustomFieldEntity, CustomFieldType } from "./schema";

export type CustomFieldOption = {
  id: string;
  label: string;
  position: number;
  status?: "active" | "archived";
};

export type CustomFieldDefinition = {
  id: string;
  entityType: CustomFieldEntity;
  name: string;
  fieldType: CustomFieldType;
  position: number;
  status: "active" | "archived";
  options: CustomFieldOption[];
};

export type RecordCustomField = Omit<CustomFieldDefinition, "id" | "entityType" | "status"> & {
  definitionId: string;
  textValue: string | null;
  numberValue: number | null;
  dateValue: string | null;
  booleanValue: boolean | null;
  optionId: string | null;
};

type DefinitionJson = {
  id: string;
  entity_type: CustomFieldEntity;
  name: string;
  field_type: CustomFieldType;
  position: number;
  status: "active" | "archived";
  options: CustomFieldOption[];
};

type RecordFieldJson = {
  definition_id: string;
  name: string;
  field_type: CustomFieldType;
  position: number;
  text_value: string | null;
  number_value: number | string | null;
  date_value: string | null;
  boolean_value: boolean | null;
  option_id: string | null;
  options: CustomFieldOption[];
};

export async function listCustomFieldDefinitions(workspaceId: string): Promise<CustomFieldDefinition[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_custom_field_definitions", { p_workspace_id: workspaceId });
  if (error) throw new DataLoadError("os campos personalizados", error);
  return ((data as unknown as DefinitionJson[] | null) ?? []).map((item) => ({
    id: item.id,
    entityType: item.entity_type,
    name: item.name,
    fieldType: item.field_type,
    position: item.position,
    status: item.status,
    options: item.options ?? [],
  }));
}
export async function getCustomFieldsForRecord(
  workspaceId: string,
  entityType: CustomFieldEntity,
  recordId: string,
): Promise<RecordCustomField[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_custom_fields_for_record", {
    p_workspace_id: workspaceId,
    p_entity_type: entityType,
    p_record_id: recordId,
  });
  if (error) throw new DataLoadError("os campos personalizados do registro", error);
  return ((data as unknown as RecordFieldJson[] | null) ?? []).map((item) => ({
    definitionId: item.definition_id,
    name: item.name,
    fieldType: item.field_type,
    position: item.position,
    options: item.options ?? [],
    textValue: item.text_value,
    numberValue: item.number_value === null ? null : Number(item.number_value),
    dateValue: item.date_value,
    booleanValue: item.boolean_value,
    optionId: item.option_id,
  }));
}
