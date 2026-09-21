import { z } from "zod";

/** Validação das telas de configuração de formulário (A11). */

const hostname = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/i, "hostname inválido");

export const formEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  pipelineId: z.string().uuid(),
  stageId: z.string().uuid(),
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
});

export const formEndpointIdSchema = z.object({ formEndpointId: z.string().uuid() });

export const setStatusSchema = formEndpointIdSchema.extend({
  status: z.enum(["active", "disabled"]),
});

export const correctLinkSchema = z.object({
  touchpointId: z.string().uuid(),
  // Versão que quem corrige está enxergando. Vazio = "ainda não há
  // cadeia" — o servidor recusa se a ponta vigente for outra.
  expectedCurrentLinkId: z.string().uuid().or(z.literal("")).optional(),
  action: z.enum(["assign", "unassign"]),
  opportunityId: z.string().uuid().or(z.literal("")).optional(),
  reason: z.string().trim().max(500).optional(),
  leadId: z.string().uuid(),
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
