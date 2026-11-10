import { z } from "zod";

export const CUSTOM_FIELD_ENTITIES = ["contact", "lead", "opportunity", "client"] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = ["short_text", "number", "date", "boolean", "single_select"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_ENTITY_LABEL: Record<CustomFieldEntity, string> = {
  contact: "Contatos",
  lead: "Leads",
  opportunity: "Oportunidades",
  client: "Clientes",
};

export const CUSTOM_FIELD_TYPE_LABEL: Record<CustomFieldType, string> = {
  short_text: "Texto curto",
  number: "Número",
  date: "Data",
  boolean: "Sim/Não",
  single_select: "Seleção única",
};

const name = z.string().trim().min(1, "Informe o nome do campo.").max(80, "Use até 80 caracteres.");
const position = z.coerce.number().int().min(0).max(10000);

export const createCustomFieldSchema = z.object({
  entityType: z.enum(CUSTOM_FIELD_ENTITIES),
  name,
  fieldType: z.enum(CUSTOM_FIELD_TYPES),
  position,
  options: z.string().max(2000).default(""),
});

export const updateCustomFieldSchema = z.object({
  definitionId: z.uuid(),
  name,
  position,
  optionsJson: z.string().max(10000),
});

export const archiveCustomFieldSchema = z.object({ definitionId: z.uuid() });

export const saveCustomFieldValuesSchema = z.object({
  entityType: z.enum(CUSTOM_FIELD_ENTITIES),
  recordId: z.uuid(),
  valuesJson: z.string().max(30000),
});

export function parseOptionLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}
