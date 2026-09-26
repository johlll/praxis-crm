import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";

/**
 * Validação das telas de configuração de formulário (A11). Ids internos
 * usam o formato solto de src/lib/uuid.ts, como o resto do projeto: os
 * ids fixos do seed não têm versão RFC válida.
 */

const hostname = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/i, "hostname inválido");

/**
 * Configuração real dos campos de resposta aceitos (item 6 da auditoria
 * pós-dry-run): antes, `answers_config` só precisava ser `{fields: [...]}`
 * — qualquer coisa dentro do array passava, a borda não recusava campo
 * fora da lista nem obrigatório ausente, e o worker não tinha contra o
 * que revalidar.
 *
 * Mesmo schema usado em TRÊS lugares: tela de configuração (criar/editar
 * o endpoint), borda pública (recusa campo não configurado/obrigatório
 * ausente/tipo ou tamanho inválido) e worker (revalida contra o SNAPSHOT
 * gravado no evento, nunca contra a configuração atual — mudar o
 * endpoint depois não pode invalidar nem reinterpretar silenciosamente
 * um evento já recebido).
 */
export const answerFieldTypeSchema = z.enum(["text", "boolean", "number"]);
export type AnswerFieldType = z.infer<typeof answerFieldTypeSchema>;

export const answerFieldDefinitionSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/, "use só minúsculas, números e sublinhado"),
  label: z.string().trim().min(1).max(160),
  type: answerFieldTypeSchema,
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(2000).optional(),
});
export type AnswerFieldDefinition = z.infer<typeof answerFieldDefinitionSchema>;

export const answersConfigSchema = z
  .object({
    fields: z.array(answerFieldDefinitionSchema).max(30),
  })
  .refine(
    (value) => new Set(value.fields.map((field) => field.key)).size === value.fields.length,
    { message: "chaves de campo duplicadas", path: ["fields"] },
  );
export type AnswersConfig = z.infer<typeof answersConfigSchema>;

export const EMPTY_ANSWERS_CONFIG: AnswersConfig = { fields: [] };

/**
 * Constrói, a partir da configuração, o schema Zod ESTRITO que valida o
 * `answers` de uma submissão: só os campos declarados, tipo certo,
 * obrigatório presente, tamanho de texto dentro do limite. Campo fora da
 * lista é rejeitado pelo `.strict()` — não "ignorado e seguido".
 */
export function buildAnswersSchema(config: AnswersConfig): z.ZodType<Record<string, string | boolean | number>> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of config.fields) {
    let valueSchema: z.ZodType;
    if (field.type === "text") {
      valueSchema = z.string().trim().max(field.maxLength ?? 2000);
      if (field.required) valueSchema = (valueSchema as z.ZodString).min(1);
    } else if (field.type === "boolean") {
      valueSchema = z.boolean();
    } else {
      valueSchema = z.number();
    }
    shape[field.key] = field.required ? valueSchema : valueSchema.optional();
  }
  return z.object(shape).strict() as z.ZodType<Record<string, string | boolean | number>>;
}

/** JSON serializado num campo oculto do formulário → AnswersConfig validado. */
const answersConfigJsonSchema = z
  .string()
  .trim()
  .optional()
  .transform((value, ctx) => {
    if (!value) return EMPTY_ANSWERS_CONFIG;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "configuração de campos inválida" });
      return z.NEVER;
    }
    const result = answersConfigSchema.safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({ code: "custom", message: "configuração de campos inválida" });
      return z.NEVER;
    }
    return result.data;
  });

export const formEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  pipelineId: uuidSchema,
  stageId: uuidSchema,
  legalArea: z.string().trim().min(1).max(120),
  initialActivityType: z.enum(["call", "meeting", "task", "email", "deadline"]),
  // Obrigatório de propósito: nenhum formulário real herda o prazo do
  // seed fictício (contrato §4).
  initialActivityDueMinutes: z.coerce.number().int().min(1).max(43200),
  captureMode: z.enum(["new_intake", "continuity"]),
  turnstileAction: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_-]+$/i, "use só letras, números, hífen ou sublinhado"),
  allowedHostnames: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
    .pipe(z.array(hostname).min(1).max(20)),
  answersConfigJson: answersConfigJsonSchema,
});

export const formEndpointIdSchema = z.object({ formEndpointId: uuidSchema });

export const setStatusSchema = formEndpointIdSchema.extend({
  status: z.enum(["active", "disabled"]),
});

export const correctLinkSchema = z.object({
  touchpointId: uuidSchema,
  // Versão que quem corrige está enxergando. Vazio = "ainda não há
  // cadeia" — o servidor recusa se a ponta vigente for outra.
  expectedCurrentLinkId: uuidSchema.or(z.literal("")).optional(),
  action: z.enum(["assign", "unassign"]),
  opportunityId: uuidSchema.or(z.literal("")).optional(),
  reason: z.string().trim().max(500).optional(),
  leadId: uuidSchema,
});

export const ATTRIBUTION_MODELS = ["first_touch", "last_touch", "conversion"] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export const ATTRIBUTION_MODEL_LABEL: Record<AttributionModel, string> = {
  first_touch: "Primeiro toque",
  last_touch: "Último toque",
  conversion: "Conversão",
};

/** Primeiro toque é o modelo INICIAL do painel (contrato §9). */
export const DEFAULT_ATTRIBUTION_MODEL: AttributionModel = "first_touch";

export function parseAttributionModel(value: string | undefined): AttributionModel {
  return (ATTRIBUTION_MODELS as readonly string[]).includes(value ?? "")
    ? (value as AttributionModel)
    : DEFAULT_ATTRIBUTION_MODEL;
}

/** Valor do filtro que representa "sem origem declarada". */
export const NO_SOURCE_FILTER = "__sem_origem__";
