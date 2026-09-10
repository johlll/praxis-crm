import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";

export const FEE_MODELS = ["fixed", "contingency", "fixed_contingency"] as const;
export const STAGE_REQUIREMENT_TYPES = ["text", "textarea", "date", "checkbox"] as const;

const valueCentsSchema = z.coerce.number().int().min(0).max(999_999_999_999).optional();
const probabilitySchema = z.coerce.number().int().min(0).max(100).optional();

export const createOpportunitySchema = z.object({
  leadId: uuidSchema,
  pipelineId: uuidSchema.optional().or(z.literal("")),
  stageId: uuidSchema.optional().or(z.literal("")),
  valueCents: valueCentsSchema,
  feeModel: z.enum(FEE_MODELS).optional().or(z.literal("")),
  probability: probabilitySchema,
  forecastDate: z.string().trim().optional().or(z.literal("")),
});

const requirementValueItemSchema = z.object({
  requirement_id: uuidSchema,
  value_text: z.string().optional(),
  value_bool: z.boolean().optional(),
});

// Versão esperada obrigatória — mesmo contrato da A4: nunca omitida "pra
// simplificar", sempre vem de um hidden field preenchido com o
// lock_version que a tela carregou.
const lockVersionSchema = z.coerce.number().int().min(0);

export const moveOpportunityStageSchema = z.object({
  opportunityId: uuidSchema,
  fromStageId: uuidSchema,
  toStageId: uuidSchema,
  lockVersion: lockVersionSchema,
  requirementValues: z.array(requirementValueItemSchema).default([]),
});

export const winOpportunitySchema = z.object({
  opportunityId: uuidSchema,
  lockVersion: lockVersionSchema,
  valueCents: z.coerce.number().int().min(0),
  feeModel: z.enum(FEE_MODELS),
  signedAt: z.string().trim().optional().or(z.literal("")),
});

export const loseOpportunitySchema = z.object({
  opportunityId: uuidSchema,
  lockVersion: lockVersionSchema,
  lostReasonId: uuidSchema,
  lostNote: z.string().trim().max(2000).optional().or(z.literal("")),
  followupDate: z.string().trim().optional().or(z.literal("")),
});

export const createPipelineStageSchema = z.object({
  pipelineId: uuidSchema,
  name: z.string().trim().min(1, "Informe o nome da etapa.").max(120),
  color: z.string().trim().optional().or(z.literal("")),
});

export const createStageRequirementSchema = z.object({
  stageId: uuidSchema,
  label: z.string().trim().min(1, "Informe o rótulo do requisito.").max(160),
  fieldType: z.enum(STAGE_REQUIREMENT_TYPES),
  hint: z.string().trim().max(200).optional().or(z.literal("")),
});

export const updatePipelineStageSchema = z.object({
  stageId: uuidSchema,
  name: z.string().trim().min(1, "Informe o nome da etapa.").max(120).optional().or(z.literal("")),
  color: z.string().trim().optional().or(z.literal("")),
  isWon: z.coerce.boolean().optional(),
  isLost: z.coerce.boolean().optional(),
});

export const reorderPipelineStagesSchema = z.object({
  pipelineId: uuidSchema,
  orderedStageIds: z.array(uuidSchema).min(1),
});

export const deleteStageRequirementSchema = z.object({
  requirementId: uuidSchema,
});

export const deactivateLostReasonSchema = z.object({
  lostReasonId: uuidSchema,
});

export const createLostReasonSchema = z.object({
  workspaceId: uuidSchema,
  label: z.string().trim().min(1, "Informe o motivo.").max(160),
});

export const listOpportunitiesFiltersSchema = z.object({
  pipelineId: uuidSchema.optional().or(z.literal("")),
  stageId: uuidSchema.optional().or(z.literal("")),
  status: z.enum(["open", "won", "lost"]).optional().or(z.literal("")),
  search: z.string().trim().max(160).optional().or(z.literal("")),
  sort: z.enum(["created_at_desc", "created_at_asc"]).default("created_at_desc"),
  page: z.coerce.number().int().min(1).default(1),
});
