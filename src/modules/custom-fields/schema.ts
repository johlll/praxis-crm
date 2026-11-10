import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";

/**
 * Campos personalizados (C4 mínima). Estrutura FECHADA: entidades e tipos são
 * listas fixas — não existe texto rico, múltipla seleção, fórmula, arquivo,
 * relacionamento, campo calculado nem JSON livre. O banco repete cada regra
 * (CHECKs, chaves compostas e as funções); isto é a primeira barreira e a
 * fonte dos rótulos da tela.
 */

export const CUSTOM_FIELD_PATH = "/configuracoes/campos-personalizados";

export const CUSTOM_FIELD_ENTITIES = ["contact", "lead", "opportunity", "client"] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = ["text", "number", "date", "boolean", "select"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_ENTITY_LABEL: Record<CustomFieldEntity, string> = {
  contact: "Contatos",
  lead: "Leads",
  opportunity: "Oportunidades",
  client: "Clientes",
};

export const CUSTOM_FIELD_TYPE_LABEL: Record<CustomFieldType, string> = {
  text: "Texto curto",
  number: "Número",
  date: "Data",
  boolean: "Sim ou não",
  select: "Seleção única",
};

export const CUSTOM_FIELD_MAX_ACTIVE_PER_ENTITY = 50;
export const CUSTOM_FIELD_MAX_OPTIONS = 30;
export const CUSTOM_FIELD_NAME_MAX = 80;
export const CUSTOM_FIELD_OPTION_MAX = 80;
export const CUSTOM_FIELD_TEXT_MAX = 500;

/** Rota da página de cada entidade (para revalidar depois de salvar valores). */
export const CUSTOM_FIELD_RECORD_PATH: Record<CustomFieldEntity, (id: string) => string> = {
  contact: (id) => `/contatos/${id}`,
  lead: (id) => `/leads/${id}`,
  opportunity: (id) => `/oportunidades/${id}`,
  client: (id) => `/clientes/${id}`,
};

export const customFieldEntitySchema = z.enum(CUSTOM_FIELD_ENTITIES);
export const customFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES);

// ---------------------------------------------------------------------
// Definições (formulário de configuração)
// ---------------------------------------------------------------------

/** Opção enviada pelo formulário: `id` só existe para opção que já está salva. */
export const customFieldOptionInputSchema = z
  .object({
    id: uuidSchema.optional(),
    label: z.string().trim().min(1, "Toda opção precisa de um texto.").max(CUSTOM_FIELD_OPTION_MAX, `Cada opção aceita até ${CUSTOM_FIELD_OPTION_MAX} caracteres.`),
  })
  .strict();
export type CustomFieldOptionInput = z.infer<typeof customFieldOptionInputSchema>;

export const customFieldDefinitionFormSchema = z
  .object({
    definitionId: z.union([uuidSchema, z.literal("")]).transform((value) => (value === "" ? null : value)),
    entity: customFieldEntitySchema,
    name: z
      .string()
      .trim()
      .min(1, "Informe o nome do campo.")
      .max(CUSTOM_FIELD_NAME_MAX, `O nome aceita até ${CUSTOM_FIELD_NAME_MAX} caracteres.`),
    type: customFieldTypeSchema,
    position: z
      .string()
      .trim()
      .transform((value, ctx) => {
        if (value === "") return null;
        if (!/^\d{1,4}$/.test(value) || Number(value) > 1000) {
          ctx.addIssue({ code: "custom", message: "A posição precisa ser um número entre 0 e 1000." });
          return z.NEVER;
        }
        return Number(value);
      }),
    options: z.array(customFieldOptionInputSchema).max(CUSTOM_FIELD_MAX_OPTIONS, `Use no máximo ${CUSTOM_FIELD_MAX_OPTIONS} opções.`),
  })
  .superRefine((form, ctx) => {
    if (form.type === "select") {
      if (form.options.length === 0) {
        ctx.addIssue({ code: "custom", path: ["options"], message: "Informe ao menos uma opção." });
      }
      const seen = new Set<string>();
      for (const option of form.options) {
        const key = option.label.toLocaleLowerCase("pt-BR");
        if (seen.has(key)) {
          ctx.addIssue({ code: "custom", path: ["options"], message: "Não repita opções." });
          break;
        }
        seen.add(key);
      }
    } else if (form.options.length > 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Só a seleção única tem opções." });
    }
  });
export type CustomFieldDefinitionForm = z.infer<typeof customFieldDefinitionFormSchema>;

/** Lê o campo `options` do formulário (JSON enviado pelo cliente) sem confiar no formato. */
export function parseOptionsField(raw: FormDataEntryValue | null): unknown {
  if (raw === null || raw === "") return [];
  if (typeof raw !== "string" || raw.length > 20_000) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Opções no formato da RPC: `[{ id?, label }]` na ordem recebida. */
export function optionsRpcArg(options: CustomFieldOptionInput[]) {
  return options.map((option) => (option.id ? { id: option.id, label: option.label } : { label: option.label }));
}

// ---------------------------------------------------------------------
// Linhas devolvidas pelo banco (validadas de novo na camada de leitura)
// ---------------------------------------------------------------------

export const customFieldDefinitionRowSchema = z.object({
  id: uuidSchema,
  entity_type: customFieldEntitySchema,
  name: z.string(),
  field_type: customFieldTypeSchema,
  position: z.number().int(),
  archived: z.boolean(),
  options: z.array(z.object({ id: uuidSchema, label: z.string(), in_use: z.boolean() })),
});

export const customFieldValueRowSchema = z.object({
  definition_id: uuidSchema,
  name: z.string(),
  field_type: customFieldTypeSchema,
  position: z.number().int(),
  options: z.array(z.object({ id: uuidSchema, label: z.string() })),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

// ---------------------------------------------------------------------
// Valores (formulário dos registros)
// ---------------------------------------------------------------------

/** Nome do campo de formulário de um valor: `cf_<id da definição>`. */
export const CUSTOM_FIELD_INPUT_PREFIX = "cf_";
export const customFieldInputName = (definitionId: string) => `${CUSTOM_FIELD_INPUT_PREFIX}${definitionId}`;

export type CustomFieldValueSubmission = { definitionId: string; type: CustomFieldType; raw: string };

/**
 * Converte o texto de um campo de formulário no valor JSON da RPC, SEMPRE pelo
 * tipo que o banco informou (nunca pelo que o navegador disse). `null` limpa o campo.
 */
export function coerceCustomFieldValue(
  type: CustomFieldType,
  raw: string,
): { ok: true; value: string | number | boolean | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };

  switch (type) {
    case "text":
      if (text.length > CUSTOM_FIELD_TEXT_MAX) {
        return { ok: false, error: `O texto aceita até ${CUSTOM_FIELD_TEXT_MAX} caracteres.` };
      }
      return { ok: true, value: text };
    case "number": {
      // Aceita vírgula decimal ("1234,5") ou ponto ("1234.5"), sem separador de milhar.
      const normalized = text.replace(",", ".");
      if (!/^-?\d{1,14}(\.\d{1,4})?$/.test(normalized)) {
        return { ok: false, error: "Número inválido: use até 14 dígitos e 4 casas decimais." };
      }
      return { ok: true, value: Number(normalized) };
    }
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ok: false, error: "Data inválida." };
      return { ok: true, value: text };
    case "boolean":
      if (text !== "true" && text !== "false") return { ok: false, error: "Escolha sim ou não." };
      return { ok: true, value: text === "true" };
    case "select": {
      const id = uuidSchema.safeParse(text);
      if (!id.success) return { ok: false, error: "Escolha uma das opções." };
      return { ok: true, value: id.data };
    }
  }
}
